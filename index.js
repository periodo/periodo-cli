#!/usr/bin/env node

const R = require('ramda')
    , fs = require('fs')
    , os = require('os')
    , parseArgs = require('minimist')
    , readline = require('readline')
    , axios = require('axios')
    , {v4: uuidv4} = require('uuid')
    , {basename} = require('path')
    , {red, green, blue, black} = require('@colors/colors/safe')
    , {promisify} = require('util')

function usage() {
  console.error(
`Usage: ${basename(process.argv[1])} <command>

  where command is one of:

  list-patches
  list-permissions
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

const DEFAULT_SERVER_URL = 'https://data.perio.do/'
const TOKEN_FILE = `${os.homedir()}/.periodo-token`

const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const deleteFile = promisify(fs.unlink)

const personalDetails = R.path(['person', 'name'])
const givenNames = R.pathOr('', ['given-names', 'value'])
const familyName = R.pipe(R.pathOr('', ['family-name', 'value']), R.toUpper)

const personalName = async orcid => {
  try {
    const response = await axios.get(
      orcid,
      {headers: {'Accept': 'application/json'}}
    )
    const details = personalDetails(response.data)
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

const viewPatchURL = patch_url => {
  const url = new URL(patch_url)
  const server_url = `https://${url.host}/`
  const view_url = new URL(server_url.replace('data', 'client'))
  view_url.pathname = '/'
  view_url.search = (
    '?page=review-patch'
    + `&backendID=web-${encodeURIComponent(server_url)}`
    + `&patchURL=${encodeURIComponent(url.pathname)}`
  )
  return view_url
}

const showPatch = async (server_url, {url, created_by, created_at}) => (
` ${b('url')}: ${blue(url)}
 ${b('who')}: ${created_by} (${await personalName(created_by)})
${b('when')}: ${created_at}
${b('view')}: ${viewPatchURL(url)}
`
)

async function showPatches(server_url, patches) {
  return Promise.all(R.map(p => showPatch(server_url, p), patches))
}

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

const extractMessage = o => ('message' in o) ? o : {message: JSON.stringify(o)}

async function sendData(client, filename, options, expectedStatus) {
  return new Promise((resolve, reject) => {
    options.data = (filename === '-')
      ? process.stdin
      : fs.createReadStream(filename)
    client.request(options)
      .then(response => {
        if (response.status === expectedStatus) {
          resolve(response.headers.location)
        } else {
          const message = (response.status === 401)
              ? {message: `
Token has expired. Delete ${TOKEN_FILE} and try again.`}
              : extractMessage(response.data)
            reject(message)
        }
      })
      .catch(reject)
  })
}

async function listPermissions(client, argv) {
  const response = await client.get(
    'identity',
    { headers: {'Authorization': `Bearer ${await getToken(argv.server)}`} }
  )
  if (response.status == 401) {
    throw {message: `Token has expired. Delete ${TOKEN_FILE} and try again.`}
  } else {
    const identity = response.data || {}
    console.log(`
${identity.name}
${identity.id}

Permissions:
`)
    if (identity.permissions.length === 0) {
      console.log('none')
    } else {
      R.forEach(console.log, identity.permissions)
    }
    console.log()
  }
}

async function listPatches(client, argv) {
  const patches = (await client.get(
    'patches',
    { params:
      { open: 'true'
      , merged: 'false'
      , order: 'asc'
      }
    }
  )).data
  if (patches.length) {
    console.error(`Open and unmerged patches at ${green(argv.server)}:
    `)
    R.forEach(console.log, await showPatches(argv.server, patches))
  } else {
    console.error(`No open and unmerged patches at ${green(argv.server)}.`)
  }
}

async function submitPatch(client, argv) {
  if (argv._.length < 1) { usage() }
  const url = `${argv.server}d.json`
  process.stderr.write(`Submitting patch to ${blue(url)} ... `)
  const patch_url = await sendData(
    client,
    argv._[0],
    { url
    , method: 'PATCH'
    , headers:
      { 'Content-Type': 'application/json'
      , 'Authorization': `Bearer ${await getToken(argv.server)}`
      }
    },
    202
  )
  return `
${patch_url}

${viewPatchURL(patch_url)}
`
}

const gerund = s => (s.slice(-1) === 'e' ? s.slice(0, -1) : s) + 'ing'

const capitalize = s => s[0].toUpperCase() + s.slice(1)

const verbPatch = verb => async function(client, argv) {
  if (argv._.length < 1) { usage() }
  const url = argv._[0]
  process.stderr.write(`${gerund(capitalize(verb))} patch ${blue(url)} ... `)
  const response = await client.request(
    { url: `${url}${verb}`
    , method: 'post'
    , headers:
      { 'Accept': 'application/json'
      , 'Connection': 'keep-alive'
      , 'Authorization': `Bearer ${await getToken(argv.server)}`
      }
    }
  )
  if (response.status == 401) {
    throw {message: `Token has expired. Delete ${TOKEN_FILE} and try again.`}
  } else if (response.status != 204) {
    throw extractMessage(response.data)
  }
}

async function createBag(client, argv) {
  if (argv._.length < 1) { usage() }
  const uuid = argv._.length > 1 ? argv._[1] : uuidv4()
  const url = `${argv.server}bags/${uuid}`
  process.stderr.write(`Creating bag ${blue(url)} ... `)
  return await sendData(
    client,
    argv._[0],
    { url
    , method: 'PUT'
    , headers:
      { 'Content-Type': 'application/json'
      , 'Authorization': `Bearer ${await getToken(argv.server)}`
      }
    },
    201
  )
}

async function updateGraph(client, argv) {
  if (argv._.length < 2) { usage() }
  const id = argv._[1]
  const url = `${argv.server}graphs/${id}`
  process.stderr.write(`Updating graph ${blue(url)} ... `)
  return await sendData(
    client,
    argv._[0],
    { url
    , method: 'PUT'
    , headers:
      { 'Content-Type': 'application/json'
      , 'Authorization': `Bearer ${await getToken(argv.server)}`
      }
    },
    201
  )
}

async function deleteGraph(client, argv) {
  if (argv._.length < 1) { usage() }
  const id = argv._[0]
  const url = `graphs/${id}`
  process.stderr.write(`Deleting graph ${blue(url)} ... `)
  const response = await client.delete(
    url,
    {headers: {'Authorization': `Bearer ${await getToken(argv.server)}`}}
  )
  if (response.status == 401) {
    throw {message: `Token has expired. Delete ${TOKEN_FILE} and try again.`}
  } else if (response.status != 204) {
    throw {message: `Server returned ${response.status}`}
  }
}

function run(asyncFn, client, argv) {
  asyncFn(client, argv)
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

  if (argv.server === undefined) {
    argv.server = DEFAULT_SERVER_URL
  }
  if (argv.server.slice(-1) !== '/') {
    argv.server += '/'
  }

  const client = axios.create(
    { baseURL: argv.server
    , validateStatus: status => status < 500
    , headers: {'User-Agent': 'PeriodO CLI 3.0'}
    }
  )

  switch (argv._.shift()) {
  case 'list-patches':
    run(listPatches, client, argv)
    break
  case 'list-permissions':
    run(listPermissions, client, argv)
    break
  case 'refresh-token':
    run(refreshToken, argv)
    break
  case 'submit-patch':
    run(submitPatch, client, argv)
    break
  case 'merge-patch':
    run(verbPatch('merge'), client, argv)
    break
  case 'reject-patch':
    run(verbPatch('reject'), client, argv)
    break
  case 'create-bag':
    run(createBag, client, argv)
    break
  case 'update-graph':
    run(updateGraph, client, argv)
    break
  case 'delete-graph':
    run(deleteGraph, client, argv)
    break
  default:
    usage()
    break
  }
}
