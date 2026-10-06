'use strict'

// Content negotiation for routes that declare a `formats` option.
// A route lists the media types it can produce (in preference order) together
// with the serializer for each of them. When a request arrives, the `Accept`
// header is parsed and the best declared format is selected:
//
// 1. The media range with the highest specificity (exact > type/* > */*)
//    that matches a declared format decides its quality value. Ranges with
//    the same specificity are resolved in header order (first one wins),
//    which also makes duplicate entries deterministic.
// 2. A quality of 0 (or an invalid q-value, which is treated as "not
//    acceptable") excludes the declared format, even if a less specific
//    wildcard range would have matched it.
// 3. Among the still acceptable formats the highest q wins; ties are broken
//    by match specificity first and by route declaration order last.
// 4. Without an `Accept` header the first declared format is used.

const Q_VALUE_REGEXP = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/

const SPECIFICITY_WILDCARD = 0
const SPECIFICITY_TYPE = 1
const SPECIFICITY_EXACT = 2

const MATCH_NAMES = ['wildcard', 'type', 'exact']

function parseQValue (raw) {
  if (Q_VALUE_REGEXP.test(raw) === false) {
    return null
  }
  return Number(raw)
}

function parseAcceptHeader (header) {
  const entries = []

  const parts = String(header).split(',')
  for (let order = 0; order < parts.length; order++) {
    const part = parts[order].trim()
    if (part === '') {
      continue
    }

    const segments = part.split(';')
    const mediaType = segments[0].trim().toLowerCase()
    const slashIndex = mediaType.indexOf('/')
    if (slashIndex === -1) {
      // Not a media range at all, nothing we can match against.
      continue
    }
    const type = mediaType.slice(0, slashIndex)
    const subtype = mediaType.slice(slashIndex + 1)
    if (type === '' || subtype === '') {
      continue
    }

    let q = 1
    for (let i = 1; i < segments.length; i++) {
      const parameter = segments[i]
      const equalIndex = parameter.indexOf('=')
      if (equalIndex === -1) {
        continue
      }
      if (parameter.slice(0, equalIndex).trim().toLowerCase() !== 'q') {
        continue
      }
      const parsed = parseQValue(parameter.slice(equalIndex + 1).trim())
      // An invalid q-value means the sender intent is unknown, so the
      // entry is treated as explicitly not acceptable (q=0).
      q = parsed === null ? 0 : parsed
    }

    let specificity = SPECIFICITY_EXACT
    if (type === '*') {
      specificity = SPECIFICITY_WILDCARD
    } else if (subtype === '*') {
      specificity = SPECIFICITY_TYPE
    }

    entries.push({ type, subtype, q, specificity, order })
  }

  return entries
}

function matches (entry, format) {
  return (entry.type === '*' || entry.type === format.type) &&
    (entry.subtype === '*' || entry.subtype === format.subtype)
}

// Normalizes the route `formats` option into a list of
// { contentType, type, subtype, serializer } preserving declaration order.
// Throws a plain Error with a descriptive message on invalid input; the
// caller is expected to wrap it in a FST_ERR_* error.
function normalizeResponseFormats (formats) {
  let declarations
  if (Array.isArray(formats)) {
    declarations = formats.map((entry) => {
      if (entry === null || typeof entry !== 'object') {
        throw new Error(`every format must be an object with a contentType and a serializer, got ${Object.prototype.toString.call(entry)}`)
      }
      return [entry.contentType, entry.serializer]
    })
  } else if (formats !== null && typeof formats === 'object') {
    declarations = Object.entries(formats)
  } else {
    throw new Error(`expected an array or an object, got ${Object.prototype.toString.call(formats)}`)
  }

  if (declarations.length === 0) {
    throw new Error('at least one format must be declared')
  }

  const seen = new Set()
  const normalized = []
  for (const [contentType, serializer] of declarations) {
    if (typeof contentType !== 'string' || contentType.trim() === '') {
      throw new Error(`format contentType must be a non-empty string, got ${Object.prototype.toString.call(contentType)}`)
    }
    if (typeof serializer !== 'function') {
      throw new Error(`format "${contentType}" must declare a serializer function`)
    }

    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
    const slashIndex = mediaType.indexOf('/')
    if (slashIndex === -1 || slashIndex === 0 || slashIndex === mediaType.length - 1) {
      throw new Error(`format contentType "${contentType}" is not a valid media type`)
    }
    if (mediaType.includes('*')) {
      throw new Error(`format contentType "${contentType}" must not contain wildcards`)
    }
    if (seen.has(mediaType)) {
      throw new Error(`format "${mediaType}" is declared more than once`)
    }
    seen.add(mediaType)

    normalized.push({
      contentType: contentType.trim(),
      type: mediaType.slice(0, slashIndex),
      subtype: mediaType.slice(slashIndex + 1),
      serializer
    })
  }

  return normalized
}

// Selects the best declared format for the given Accept header value.
// Returns null when nothing is acceptable (the caller answers 406),
// otherwise { index, q, match, reason } where `index` addresses the
// normalized formats array and `reason` is a human readable explanation.
function selectFormat (acceptHeader, formats) {
  if (acceptHeader === undefined || acceptHeader === null || String(acceptHeader).trim() === '') {
    return {
      index: 0,
      q: 1,
      match: 'default',
      reason: `no Accept header, using first declared format "${formats[0].contentType}"`
    }
  }

  const entries = parseAcceptHeader(acceptHeader)

  let best = null
  for (let index = 0; index < formats.length; index++) {
    const format = formats[index]

    // The most specific matching media range governs the quality of this
    // format. Ranges with equal specificity are won by the first one in
    // header order, so duplicate entries are deterministic.
    let governing = null
    for (const entry of entries) {
      if (matches(entry, format) === false) {
        continue
      }
      if (governing === null || entry.specificity > governing.specificity) {
        governing = entry
      }
    }

    if (governing === null || governing.q <= 0) {
      // Not listed in the Accept header, or explicitly excluded with q=0
      // (invalid q-values have already been folded into q=0 while parsing).
      continue
    }

    if (
      best === null ||
      governing.q > best.q ||
      (governing.q === best.q && governing.specificity > best.specificity)
      // A tie on both q and specificity keeps the format that was declared
      // first by the route.
    ) {
      const range = governing.specificity === SPECIFICITY_EXACT
        ? `${governing.type}/${governing.subtype}`
        : governing.specificity === SPECIFICITY_TYPE
          ? `${governing.type}/*`
          : '*/*'
      best = {
        index,
        q: governing.q,
        specificity: governing.specificity,
        match: MATCH_NAMES[governing.specificity],
        reason: `matched Accept range "${range}" with q=${governing.q}`
      }
    }
  }

  return best
}

module.exports = {
  parseAcceptHeader,
  normalizeResponseFormats,
  selectFormat
}
