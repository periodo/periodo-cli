#!/usr/bin/env node

const R = require('ramda')
    , concat = require('concat-stream')
    , fs = require('fs')
    , os = require('os')
    , parseArgs = require('minimist')
    , readline = require('readline')
    , request = require('request')
    , uuidv4 = require('uuid/v4')
    , {URL} = require('url')
    , {basename} = require('path')
    , {red, green, blue, black} = require('colors/safe')
    , {promisify} = require('util')

function usage() {
  console.error(
`Usage: ${basename(process.argv[1])} <command>

  where command is one of:

  list-patches
  submit-patch <patch file>
  merge-patch  <patch url>
  reject-patch <patch url>
  create-bag   <json file> [<uuid>]

  To pipe patches or JSON via stdin use the filename '-'.

  To use a server other than canonical:

  -s --server <server url>
`)
  process.exit(1)
}

const DEFAULT_SERVER_URL = 'http://n2t.net/ark:/99152/p0'
const TOKEN_FILE = `${os.homedir()}/.periodo-token`

const requestGET = promisify(request.get)
const requestHEAD = promisify(request.head)
const requestPOST = promisify(request.post)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)

const personalDetails = R.path(['person', 'name'])
const givenNames = R.pathOr('', ['given-names', 'value'])
const familyName = R.pipe(R.pathOr('', ['family-name', 'value']), R.toUpper)

const personalName = async orcid => {
  try {
    const o = (await requestGET({uri: orcid, json: true})).body
        , details = personalDetails(o)
    if (details === undefined) {
      return 'anonymous'
    }
    const personalName = `${familyName(details)} ${givenNames(details)}`
    return personalName.trim() ? personalName : 'anonymous'
  } catch (e) {
    return e.message
  }
}

const b = black.bold

const showPatch = async (server_url, {url, created_by, created_at}) => (
`${b('url')}: ${blue(url)}
 ${b('who')}: ${created_by} (${await personalName(created_by)})
${b('when')}: ${created_at}
${b('view')}: ${server_url}#/patches/${url}
`)

async function showPatches(server_url, patches) {
  return Promise.all(R.map(p => showPatch(server_url, p), patches))
}

const resolve = async url => (await requestHEAD(url)).request.uri.href

async function askForInput(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface(
      {input: process.stdin, output: process.stdout}
    )
    rl.question(prompt, input => {
      rl.close()
      resolve(input)
    })
  })
}

async function getToken(server_url) {
  try {
    return await readFile(TOKEN_FILE)
  } catch (e) {
    console.log(red('authorization required'))
    const token = await askForInput(`
An authentication token is needed. Open the following URL in a browser, sign in
or register with ORCID, and grant the requested permissions to PeriodO:

${server_url}register?cli

Then copy and paste the resulting authentication token here: `)
    await writeFile(TOKEN_FILE, token)
    return token
  }
}

function extractMessage(buffer) {
  const s = buffer.toString('utf8')
  try {
    return JSON.parse(s)
  } catch (e) {
    return {message: s}
  }
}

async function sendData(filename, options, expectedStatusCode) {
  return new Promise((resolve, reject) => {
    const requestStream = request(options)
      .on('error', reject)
      .on('response', response => {
        if (response.statusCode === expectedStatusCode) {
          resolve()
        } else {
          requestStream.pipe(concat(buffer => {
            const message = (response.statusCode === 401)
              ? {message: `
Token has expired. Delete ${TOKEN_FILE} and try again.`}
              : extractMessage(buffer)
            reject(message)
          }))
        }
      })
    const dataStream = (filename === '-')
      ? process.stdin
      : fs.createReadStream(filename)
    dataStream.on('error', reject).pipe(requestStream)
  })
}

async function listPatches(argv) {
  const unmergedPatches = new URL(
    `${argv.server}patches?open=true&merged=false&order=asc`).toString()
  const patches = (await requestGET({uri: unmergedPatches, json: true})).body
  if (patches.length) {
    console.log(`Open and unmerged patches at ${green(argv.server)}:
    `)
    R.forEach(console.log, await showPatches(argv.server, patches))
  } else {
    console.log(`No open and unmerged patches at ${green(argv.server)}.`)
  }
}

async function submitPatch(argv) {
  if (argv._.length < 1) { usage() }
  const url = `${argv.server}d.json`
  process.stdout.write(`Submitting patch to ${blue(url)} ... `)
  await sendData(
    argv._[0],
    { url
    , method: 'PATCH'
    , headers: {'Content-Type': 'application/json'}
    , auth: {bearer: await getToken(argv.server)}
    },
    202
  )
}

const gerund = s => (s.slice(-1) === 'e' ? s.slice(0, -1) : s) + 'ing'

const capitalize = s => s[0].toUpperCase() + s.slice(1)

const verbPatch = verb => async function(argv) {
  if (argv._.length < 1) { usage() }
  const url = argv._[0]
  process.stdout.write(`${gerund(capitalize(verb))} patch ${blue(url)} ... `)
  const o = await requestPOST(
    { uri: `${url}${verb}`
    , headers: {'Accept': 'application/json'}
    , auth: {bearer: await getToken(argv.server)}
    }
  )
  if (o.statusCode == 401) {
    throw {message: `Token has expired. Delete ${TOKEN_FILE} and try again.`}
  } else if (o.statusCode != 204) {
    throw {message: `Server returned ${o.statusCode}`}
  }
}

async function createBag(argv) {
  if (argv._.length < 1) { usage() }
  const uuid = argv._.length > 1 ? argv._[1] : uuidv4()
  const url = `${argv.server}bags/${uuid}`
  process.stdout.write(`Creating bag ${blue(url)} ... `)
  await sendData(
    argv._[0],
    { url
    , method: 'PUT'
    , headers: {'Content-Type': 'application/json'}
    , auth: {bearer: await getToken(argv.server)}
    },
    201
  )
}

const handleError = e => {
  console.log(red('failed.'))
  console.log(e.message)
}

function run(asyncFn, argv) {
  asyncFn(argv)
    .then(e => {
      if (e) {
        handleError(e)
      } else {
        console.log(green('OK'))
      }
    })
    .catch(handleError)
}

if (require.main === module) {

  const argv = parseArgs(process.argv.slice(2), {alias: {s: 'server'}})

  if (argv._.length === 0) {
    usage()
  }

  resolve(DEFAULT_SERVER_URL).then(default_server => {
    if (argv.server === undefined) {
      argv.server = default_server
    }
    if (argv.server.slice(-1) !== '/') {
      argv.server += '/'
    }

    switch (argv._.shift()) {
      case 'list-patches':
        run(listPatches, argv)
        break
      case 'submit-patch':
        run(submitPatch, argv)
        break
      case 'merge-patch':
        run(verbPatch('merge'), argv)
        break
      case 'reject-patch':
        run(verbPatch('reject'), argv)
        break
      case 'create-bag':
        run(createBag, argv)
        break
      default:
        usage()
        break
    }
  })
}
