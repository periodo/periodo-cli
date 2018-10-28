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
  refresh-token
  submit-patch <patch file>
  merge-patch  <patch url>
  reject-patch <patch url>
  create-bag   <json file> [<uuid>]
  update-graph <json file> <graph uri path>
  delete-graph <graph uri path>

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
const requestDELETE = promisify(request.delete)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const deleteFile = promisify(fs.unlink)

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

const resolveURL = async url => (await requestHEAD(url)).request.uri.href

async function askForInput(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface(
      {input: process.stdin, output: process.stderr}
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
    console.error(red('authorization required'))
    const token = await askForInput(`
An authentication token is needed. Open the following URL in a browser, sign in
or register with ORCID, and grant the requested permissions to PeriodO:

${server_url}register?cli

Then copy and paste the resulting authentication token here: `)
    await writeFile(TOKEN_FILE, token)
    return token
  }
}

async function refreshToken(argv) {
  if (fs.existsSync(TOKEN_FILE)) {
    await deleteFile(TOKEN_FILE)
  }
  await getToken(argv.server)
}

function extractMessage(s) {
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
          resolve(response.headers.location)
        } else {
          requestStream.pipe(concat(buffer => {
            const message = (response.statusCode === 401)
              ? {message: `
Token has expired. Delete ${TOKEN_FILE} and try again.`}
              : extractMessage(buffer.toString('utf8'))
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
    console.error(`Open and unmerged patches at ${green(argv.server)}:
    `)
    R.forEach(console.log, await showPatches(argv.server, patches))
  } else {
    console.error(`No open and unmerged patches at ${green(argv.server)}.`)
  }
}

async function submitPatch(argv) {
  if (argv._.length < 1) { usage() }
  const url = `${argv.server}d.json`
  process.stderr.write(`Submitting patch to ${blue(url)} ... `)
  return await sendData(
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
  process.stderr.write(`${gerund(capitalize(verb))} patch ${blue(url)} ... `)
  const o = await requestPOST(
    { uri: `${url}${verb}`
    , headers: {'Accept': 'application/json'}
    , auth: {bearer: await getToken(argv.server)}
    }
  )
  if (o.statusCode == 401) {
    throw {message: `Token has expired. Delete ${TOKEN_FILE} and try again.`}
  } else if (o.statusCode != 204) {
    throw extractMessage(o.body)
  }
}

async function createBag(argv) {
  if (argv._.length < 1) { usage() }
  const uuid = argv._.length > 1 ? argv._[1] : uuidv4()
  const url = `${argv.server}bags/${uuid}`
  process.stderr.write(`Creating bag ${blue(url)} ... `)
  return await sendData(
    argv._[0],
    { url
    , method: 'PUT'
    , headers: {'Content-Type': 'application/json'}
    , auth: {bearer: await getToken(argv.server)}
    },
    201
  )
}

async function updateGraph(argv) {
  if (argv._.length < 2) { usage() }
  const id = argv._[1]
  const url = `${argv.server}graphs/${id}`
  process.stderr.write(`Updating graph ${blue(url)} ... `)
  return await sendData(
    argv._[0],
    { url
    , method: 'PUT'
    , headers: {'Content-Type': 'application/json'}
    , auth: {bearer: await getToken(argv.server)}
    },
    201
  )
}

async function deleteGraph(argv) {
  if (argv._.length < 1) { usage() }
  const id = argv._[0]
  const url = `${argv.server}graphs/${id}`
  process.stderr.write(`Deleting graph ${blue(url)} ... `)
  const o = await requestDELETE(
    { uri: url
    , auth: {bearer: await getToken(argv.server)}
    }
  )
  if (o.statusCode == 401) {
    throw {message: `Token has expired. Delete ${TOKEN_FILE} and try again.`}
  } else if (o.statusCode != 204) {
    throw {message: `Server returned ${o.statusCode}`}
  }
}

function run(asyncFn, argv) {
  asyncFn(argv)
    .then(
      message => {
        console.error(green('OK'))
        if (message) {
          console.log(message)
        }
      },
      error => {
        console.error(red('failed'))
        console.error(error.message)
      }
    )
}

if (require.main === module) {

  const argv = parseArgs(process.argv.slice(2), {alias: {s: 'server'}})

  if (argv._.length === 0) {
    usage()
  }

  resolveURL(DEFAULT_SERVER_URL).then(default_server => {
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
      case 'refresh-token':
        run(refreshToken, argv)
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
      case 'update-graph':
        run(updateGraph, argv)
        break
      case 'delete-graph':
        run(deleteGraph, argv)
        break
      default:
        usage()
        break
    }
  })
}
