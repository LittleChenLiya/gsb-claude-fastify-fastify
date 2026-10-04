# Schema compatibility check (offline)

`lib/schema-compat.js` is an offline compatibility check for two request JSON
Schemas of the same route: the currently deployed (old) schema and the proposed
(new) schema. It finds **concrete inputs the old schema accepts but the new
schema rejects**, so a schema upgrade can be reviewed before deployment.

It is deliberately conservative: anything it cannot prove yields `unknown`,
never a clean bill of health.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `compatible` | No input found that old accepts but new rejects, within the supported scope. |
| `incompatible` | At least one concrete counterexample found and independently verified. |
| `unknown` | Unsupported keywords, unresolvable `$ref`, or a structural difference that Fastify's coercion/default behavior may absorb. Manual review required. |

`unknown` never implies "compatible".

## Supported scope

The structural comparison reasons about these keywords:

- **Object fields** — `type: "object"`, `properties`, nested objects, `items`
  (array elements).
- **`required`** — a field that is optional in old but required in new produces
  a missing-key counterexample (the object without that field).
- **Scalar types** — `string`, `number`, `integer`, `boolean`, `null`, plus
  `type` arrays.
- **`enum` / `const`** — a value old allows but new does not (e.g. enum
  `["a","b"]` -> `["a"]` yields `"b"`).
- **Numeric bounds** — `minimum`, `maximum`, `exclusiveMinimum`,
  `exclusiveMaximum` (draft-4 boolean form and draft-6 numeric form).
- **`$ref`** — resolved against the registered schemas (the Fastify schema
  bucket, keyed by `$id`), including JSON Pointer fragments
  (`$id#/properties/name`).
- **Annotations** — `title`, `description`, `default`, `examples`, `$comment`,
  `$schema`, `$id`, `$defs`/`definitions`, `nullable` are ignored for
  generation (defaults are honored during verification).

## Out of scope (return `unknown`)

These keywords are not reasoned about; if any is reachable through `$ref`, the
verdict is `unknown`:

- Combinators: `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`.
- String constraints: `pattern`, `format`, `minLength`, `maxLength`,
  `patternProperties`.
- Array constraints: `minItems`, `maxItems`, `uniqueItems`, `contains`,
  `additionalItems`, tuple-form `items` (draft-4 arrays).
- Object constraints: `minProperties`, `maxProperties`, `propertyNames`,
  `dependentRequired`, `dependentSchemas`, `unevaluatedProperties`,
  `unevaluatedItems`.
- Numeric `multipleOf`.
- Dynamic refs: `$recursiveRef`, `$recursiveAnchor`, `$dynamicRef`,
  `$dynamicAnchor`.

A `$ref` that cannot be resolved against the registered schemas also yields
`unknown`.

## How counterexamples are verified

Every candidate input is re-checked with **two independent validators** built
exactly as Fastify builds them (`@fastify/ajv-compiler` default options:
`coerceTypes: "array"`, `useDefaults: true`, `removeAdditional: true`):

- one validator for the old schema,
- one validator for the new schema.

A candidate is reported only when the old validator accepts it **and** the new
validator rejects it. This means:

- Coercion (`coerceTypes`) is applied during verification, so a type change that
  coercion absorbs is not reported as a counterexample.
- Default filling (`useDefaults`) is applied during verification, so a newly
  required field with a default is filled and accepted.
- Additional-property removal (`removeAdditional`) is applied during
  verification, so a removed property is stripped rather than rejected.

## Read-only isolation

- Coercion and default filling execute on **deep clones** of the input; the
  original input is never mutated.
- The old and new schemas and the registered schemas are **never mutated** by
  the check (Ajv compiles with `addUsedSchema: false`).

## CLI

A local Node command is provided at `scripts/schema-compat.js`:

```sh
node scripts/schema-compat.js \
  --old  old-schema.json \
  --new  new-schema.json \
  --schemas registered-schemas.json \
  --part body
```

Options:

- `--old <file>` — path to the old (deployed) request schema JSON. **Required.**
- `--new <file>` — path to the new (proposed) request schema JSON. **Required.**
- `--schemas <file>` — path to a JSON object of registered schemas (keyed by
  `$id`), used to resolve `$ref`. Optional.
- `--part <body|querystring>` — which request part the schemas describe.
  Defaults to `body`.
- `--help` — show usage.

Exit codes:

- `0` — `compatible`
- `1` — `incompatible` (counterexamples printed as JSON on stdout)
- `2` — `unknown`
- `3` — usage / I/O error

The JSON output is the result object:

```json
{
  "verdict": "incompatible",
  "part": "body",
  "counterexamples": [
    {
      "path": "color",
      "input": { "color": "b" },
      "reason": "enum-narrowed",
      "verified": { "oldAccepts": true, "newRejects": true }
    }
  ]
}
```

## Programmatic API

```js
const { checkSchemaCompatibility } = require('./lib/schema-compat')

const result = checkSchemaCompatibility(oldSchema, newSchema, {
  schemas,           // registered schemas map ($id -> schema), optional
  part: 'body'      // or 'querystring', optional
})

if (result.verdict === 'incompatible') {
  for (const counterexample of result.counterexamples) {
    console.log(counterexample.path, counterexample.input, counterexample.reason)
  }
} else if (result.verdict === 'unknown') {
  console.log('manual review required:', result.reason, result.unsupported)
}
```

## Limitations

- The structural comparison is exhaustive over the supported keywords but does
  not model every JSON Schema keyword. Out-of-scope keywords yield `unknown`.
- A structural difference that Fastify's coercion/default behavior absorbs is
  reported as `unknown` (not `compatible`), because no concrete input could be
  confirmed.
- The check is offline and deterministic; it does not sample random inputs.
