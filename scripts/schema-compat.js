#!/usr/bin/env node
'use strict'

// Local offline compatibility check for two request JSON Schemas (old vs new)
// of the same route.
//
// Usage:
//   node scripts/schema-compat.js --old <old.json> --new <new.json> [options]
//
// Options:
//   --old <file>       Path to the currently deployed (old) request schema JSON.
//   --new <file>       Path to the proposed (new) request schema JSON.
//   --schemas <file>   Path to a JSON object of registered schemas (keyed by
//                       $id), used to resolve $ref values. Optional.
//   --part <body|querystring>  Which request part the schemas describe.
//                       Defaults to 'body'.
//   --help             Show this help.
//
// Exit codes:
//   0  compatible       No input found that old accepts but new rejects.
//   1  incompatible     At least one concrete counterexample found.
//   2  unknown          Unsupported keywords or unresolvable $ref; no success
//                       claim is made.
//   3  usage / I/O error.
//
// The JSON files contain a single JSON Schema object (or, for --schemas, an
// object mapping $id -> schema).

const fs = require('fs')
const path = require('path')
const { checkSchemaCompatibility } = require('../lib/schema-compat')

function parseArgs (argv) {
  const args = { old: null, new: null, schemas: null, part: 'body' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--old') args.old = argv[++i]
    else if (arg === '--new') args.new = argv[++i]
    else if (arg === '--schemas') args.schemas = argv[++i]
    else if (arg === '--part') args.part = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
    else {
      process.stderr.write(`Unknown argument: ${arg}\n`)
      args.error = true
    }
  }
  return args
}

function loadJson (file) {
  const resolved = path.resolve(file)
  const raw = fs.readFileSync(resolved, 'utf8')
  return JSON.parse(raw)
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.error || !args.old || !args.new) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\?\n?/, ''))
    process.exit(args.help ? 0 : 3
    )
  }

  let oldSchema
  let newSchema
  let schemas = {}
  try {
    oldSchema = loadJson(args.old)
    newSchema = loadJson(args.new)
    if (args.schemas) schemas = loadJson(args.schemas)
  } catch (err) {
    process.stderr.write(`Failed to load JSON: ${err.message}\n`)
    process.exit(3)
  }

  if (args.part !== 'body' && args.part !== 'querystring') {
    process.stderr.write(`Invalid --part: ${args.part} (expected body or querystring)\n`)
    process.exit(3)
  }

  const result = checkSchemaCompatibility(oldSchema, newSchema, { schemas, part: args.part })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')

  if (result.verdict === 'incompatible') process.exit(1)
  if (result.verdict === 'unknown') process.exit(2)
  process.exit(0)
}

main()
