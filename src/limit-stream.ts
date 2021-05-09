import { Transform } from 'stream';

export class LimitStream extends Transform {
  protected bytes: number;
  protected limit: number;

  constructor(limit: number) {
    super();
    this.bytes = 0;
    this.limit = limit;
  }

  _transform(
    chunk: string | NodeJS.ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
    encoding: BufferEncoding,
    callback: (err?: Error) => any
  ) {
    var length = !Buffer.isBuffer(chunk) ? Buffer.byteLength(chunk, encoding) : chunk.length;

    this.bytes += length;

    if (this.bytes > this.limit) {
      var err = new Error('maximum file length exceeded');
      (err as Error & { code: string }).code = 'ETOOBIG';
      callback(err);
    } else {
      this.push(chunk);
      this.emit('progress', this.bytes, length);
      callback();
    }
  }
}
