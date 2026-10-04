<h1 align="center">Fastify</h1>

## Offline Schema Compatibility Check
<a id="schema-compatibility"></a>

`lib/schema-compat-checker` is an **offline** helper that compares the old and
the new JSON schema of the same route section (`body`, `querystring`,
`params`, or `headers`) before an upgrade is deployed. It looks for concrete
inputs that the **old schema accepts but the new schema rejects**
("counterexamples"), so a breaking change is caught with an example payload
instead of a production 400.

```js
const { checkSchemaCompatibility } = require('fastify/lib/schema-compat-checker')

const result = checkSchemaCompatibility({
  oldSchema: { type: 'object', properties: { name: { type: 'string' } } },
  newSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  }
})
// {
//   status: 'incompatible',
//   counterexamples: [
//     { path: '(root)', input: {}, reason: 'key "name" is required ...' }
//   ],
//   unknowns: []
// }
```

### Options
<a id="schema-compatibility-options"></a>

+ `oldSchema` / `newSchema` (object, required): the two JSON schemas to
  compare. Neither is mutated.
+ `refs` (array, optional): shared schemas with an `$id`, the same schemas
  the application registers with
  [`fastify.addSchema()`](./Server.md#addschema). `$ref` values are resolved
  against them and against local `#/...` pointers.
+ `fastifyOptions` (object, optional): a subset of the Fastify server options
  (`ajv`, `schemaController`) used to mirror the target application's
  validator configuration when counterexamples are re-verified.

### Result
<a id="schema-compatibility-result"></a>

+ `status`:
  + `'incompatible'` — at least one counterexample was found **and confirmed**
    by two independent validators.
  + `'unknown'` — no counterexample could be confirmed, but the schemas use
    keywords outside the supported scope (or a candidate could not be
    constructed/confirmed). **Never treat this as compatible.**
  + `'compatible'` — every keyword of both schemas is inside the supported
    scope and no counterexample exists. Compatibility is never claimed from
    sampling: it is only reported when the whole schema pair was analyzed.
+ `counterexamples`: array of `{ path, input, reason }`. `input` is a
  complete payload that passes the old schema and fails the new one.
+ `unknowns`: array of `{ path, keyword, reason }` explaining what could not
  be analyzed.

### Supported scope
<a id="schema-compatibility-scope"></a>

Only the following keywords are analyzed:

+ object fields: `properties`, `required`, `additionalProperties` (boolean
  form only)
+ scalar `type`: `string`, `number`, `integer`, `boolean`, `null`, `object`,
  `array`
+ `enum` and `const`
+ numeric bounds: `minimum`, `maximum`, `exclusiveMinimum`,
  `exclusiveMaximum`
+ `$ref` (registered `refs` and local `#/...` pointers)

Any other keyword — composition (`allOf`, `anyOf`, `oneOf`, `not`),
conditionals (`if`/`then`/`else`), `pattern`, `format`, string lengths,
array keywords (`items`, `minItems`, ...), `multipleOf`, schema-valued
`additionalProperties`, etc. — is outside the supported scope and forces an
`'unknown'` status instead of a compatibility claim.

### Verification and isolation guarantees
<a id="schema-compatibility-guarantees"></a>

+ Every candidate counterexample is re-verified by **two independent
  validators** built through the Fastify schema controller, i.e. with the
  same ajv configuration a real Fastify instance would use (including
  `coerceTypes`, `useDefaults`, and `removeAdditional` defaults, or the
  `fastifyOptions.ajv` overrides supplied by the caller). A candidate is
  reported only when **both** validators agree: old schema accepts, new
  schema rejects.
+ Validation always runs on **isolated deep copies**: ajv coercion and
  default filling can never mutate the caller's schemas or the reported
  counterexample inputs. Schemas are also deep-copied before compilation.

Note that Fastify's default ajv configuration coerces scalars
(`coerceTypes: 'array'`) and strips undeclared object keys
(`removeAdditional: true`). Narrowings that are neutralized by those
behaviors (e.g. `additionalProperties: false` with the default config) are
therefore reported as `'unknown'`, not as false incompatibilities.

### Running the tests
<a id="schema-compatibility-tests"></a>

The checker is covered by a small, deterministic test suite that runs
locally without any service:

```bash
node --test test/schema-compat-checker.test.js
# or
npm run test:schema-compat
```
