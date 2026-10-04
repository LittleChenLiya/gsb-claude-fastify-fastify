<h1 align="center">Fastify</h1>

## Response Projection

Response projection removes or replaces sensitive fields of a response payload
before it is serialized and sent. It is configured per route through the
`projection` route option and is driven by two inputs:

1. the route `schema.response` JSON Schemas (per status code, including shared
   `$ref`s), and
2. an explicit list of sensitive paths.

The projection runs after `preSerialization` hooks and before the response
serializer, so neither the client nor the `onSend` hooks can observe the
sensitive values. The object returned by the route handler is **never
mutated**: projection is applied copy-on-write.

```js
fastify.get('/users', {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          users: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                token: { type: 'string' }
              }
            }
          }
        }
      }
    }
  },
  projection: {
    paths: ['users[*].token']
  }
}, async () => {
  return { users: [{ id: 1, token: 'secret' }] }
})
// -> {"users":[{"id":1}]}
```

### Options

- `paths` (required): a non-empty array of sensitive paths. Each entry is
  either a string or an object `{ path, action, replacement }` that overrides
  the global action for that path. Path segments are separated by `.`; a
  segment suffixed with `[*]` (or a bare `*`) selects every item of an array,
  e.g. `users[*].token`. A numeric segment selects an array index.
- `action`: `'remove'` (default) deletes the field; `'replace'` substitutes it
  with `replacement` (default `'[REDACTED]'`).
- `replacement`: the value used by the `replace` action.
- `onAmbiguous`: how to handle sensitive paths that cross an ambiguous schema
  combinator (`oneOf`, `anyOf`, `if`/`then`/`else`, `not`) where the matching
  branch cannot be uniquely determined at compile time:
  - `'error'` (default): the route fails to boot with
    `FST_ERR_PROJECTION_AMBIGUOUS`. Branches are never guessed.
  - `'redact-subtree'`: the whole value at the ambiguous location is removed
    (or replaced) at runtime, so no branch can leak.

Invalid projection configurations throw `FST_ERR_PROJECTION_INVALID`
synchronously at route registration time.

### Status code selection

The projection is compiled against the response schema of every declared
status code (`200`, `2xx`, `default`, ...), following the same lookup rules as
the response serializer. Sensitive paths are always applied — even for status
codes without a declared response schema — so a field declared sensitive can
never leak through an undeclared response shape.

### Notes

- Shared schemas added with `fastify.addSchema()` are resolved when compiling
  the projection, including circular `$ref` structures.
- The projection also applies to error responses produced by custom error
  handlers, selected by the error response status code.
- If the payload contains circular references, the projection terminates
  safely; the serializer may still reject the payload with a serialization
  error (resulting in a `500`), which never contains the projected values.
