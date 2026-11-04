/**
 * An answer that is already JSON text (a cached copy): app.ts writes it into the response as it is, instead of
 * reading the text back into objects only to turn them into the same text again. Same bytes on the wire.
 */
export class RawJson {
  constructor(readonly text: string) {}
}
