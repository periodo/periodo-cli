#!/usr/bin/env node

const R = require('ramda')
    , concat = require('concat-stream')
    , fs = require('fs')
    , os = require('os')
    , parseArgs = require('minimist')
    , readline = require('readline')
    , request = require('request')
    , {URL} = require('url')
    , {basename} = require('path')
    , {red, green, blue, black} = require('colors/safe')
    , {promisify} = require('util')

function usage() {
  console.error(
    `Usage: ${basename(process.argv[1])}`
    + ' { list | submit <patch> | reject <patch url> }'
  )
  process.exit(1)
}

const TOKEN_FILE = `${os.homedir()}/.periodo-token`

const requestGET = promisify(request.get)
const requestHEAD = promisify(request.head)
const requestPOST = promisify(request.post)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)

const personalDetails = R.path(
  ['orcid-profile', 'orcid-bio', 'personal-details']
)

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

const showPatch = async ({url, created_by, created_at}) => `
 ${b('url')}: ${blue(url)}
 ${b('who')}: ${created_by} (${await personalName(created_by)})
${b('when')}: ${created_at}
${b('view')}: http://n2t.net/ark:/99152/p0#/patches/${url}`

async function showPatches(patches) {
  return Promise.all(R.map(showPatch, patches))
}

const unmergedPatches = new URL('http://n2t.net/ark:/99152/p0patches'
  + '?open=true&merged=false&order=asc').toString()

async function listUnmergedPatches() {
  const patches = (await requestGET({uri: unmergedPatches, json: true})).body
  console.log('Open and unmerged patches:')
  R.forEach(console.log, await showPatches(patches))
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

async function getToken() {
  try {
    return await readFile(TOKEN_FILE)
  } catch (e) {
    console.log(red('authorization required'))
    const token = await askForInput(`
An authentication token is needed. See:
https://github.com/periodo/periodo-patches#authentication

Authentication token: `)
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
          requestStream.pipe(concat(buffer => reject(extractMessage(buffer))))
        }
      })
    fs.createReadStream(filename)
      .on('error', reject)
      .pipe(requestStream)
  })
}

async function submitPatch(filename) {
  const server_url = await resolve('http://n2t.net/ark:/99152/p0')
  process.stdout.write(`Submitting patch to ${server_url}d.json... `)
  await sendData(
    filename,
    { url: `${server_url}d.json`
    , method: 'PATCH'
    , headers: {'Content-Type': 'application/json'}
    , auth: {bearer: await getToken()}
    },
    202
  )
}

async function rejectPatch(url) {
  process.stdout.write(`Rejecting patch ${url}... `)
  await requestPOST(
    { uri: `${url}reject`
    , headers: {'Accept': 'application/json'}
    , auth: {bearer: await getToken()}
    },
    204
  )
}

const handleError = e => {
  console.log(red('failed'))
  console.log(e.message)
}

function run(asyncFn, argv) {
  if (argv._.length < 2) { usage() }
  asyncFn(argv._[1])
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

  const argv = parseArgs(process.argv.slice(2))

  if (argv._.length === 0) {
    usage()
  }

  switch (argv._[0]) {
    case 'list':
      listUnmergedPatches()
      break
    case 'submit':
      run(submitPatch, argv)
      break
    case 'reject':
      run(rejectPatch, argv)
      break
    default:
      usage()
      break
  }
}
