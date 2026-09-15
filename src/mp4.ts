/**
 * How long an .m4a actually is, read out of the file itself.
 *
 * The proxy meters transcription in audio seconds, and a caller that is
 * trusted to say how long its own audio is can simply say "one second". A
 * byte count is no substitute: seconds per byte depends on the bitrate the
 * caller chose, so 12MB is eight minutes at 192kbps and over three hours at
 * 8kbps. The only number that cannot be argued with is the one in the file.
 *
 * An MP4 is a tree of boxes, each [4-byte size][4-byte type][payload]. The
 * movie header, moov/mvhd, carries a timescale and a duration in those
 * units; their quotient is the length in seconds. That is all this reads. It
 * does not decode, validate, or trust anything else about the file, and it
 * returns null rather than guessing when the boxes are not there, which is
 * what an .mp3 or a .wav will do.
 */

const MVHD_MIN_V0 = 16 + 4; // version+flags, two times, timescale, duration
const MVHD_MIN_V1 = 28 + 8;

/** Read a box header at `at`. Null when it does not fit or is malformed. */
function boxAt(view: DataView, at: number, end: number) {
  if (at + 8 > end) return null;
  const declared = view.getUint32(at);
  const type = String.fromCharCode(
    view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7),
  );
  let header = 8;
  let size = declared;
  if (declared === 1) {
    // A 64-bit size follows the type. Sizes past 2^53 are not real files.
    if (at + 16 > end) return null;
    const high = view.getUint32(at + 8);
    const low = view.getUint32(at + 12);
    size = high * 0x100000000 + low;
    header = 16;
  } else if (declared === 0) {
    size = end - at; // "to the end of the file"
  }
  if (size < header || at + size > end) return null;
  return { type, body: at + header, next: at + size };
}

/** Walk the boxes between `from` and `end`, looking for one of `type`. */
function find(view: DataView, from: number, end: number, type: string) {
  let at = from;
  while (at < end) {
    const box = boxAt(view, at, end);
    if (!box) return null;
    if (box.type === type) return box;
    at = box.next;
  }
  return null;
}

/**
 * The duration in seconds of an MP4/M4A, or null if this is not one or the
 * header cannot be read. `moov` sits at the end of the file as often as the
 * start, so the whole buffer has to be in hand.
 */
export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = find(view, 0, bytes.byteLength, "moov");
  if (!moov) return null;
  const mvhd = find(view, moov.body, moov.next, "mvhd");
  if (!mvhd) return null;

  const version = view.getUint8(mvhd.body);
  const available = mvhd.next - mvhd.body;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (available < MVHD_MIN_V1) return null;
    timescale = view.getUint32(mvhd.body + 20);
    duration = view.getUint32(mvhd.body + 24) * 0x100000000 + view.getUint32(mvhd.body + 28);
  } else {
    if (available < MVHD_MIN_V0) return null;
    timescale = view.getUint32(mvhd.body + 12);
    duration = view.getUint32(mvhd.body + 16);
  }
  // A zero timescale is meaningless, and 0xFFFFFFFF is what a writer that
  // did not know the length leaves behind.
  if (!timescale || !Number.isFinite(duration) || duration === 0xffffffff) return null;
  const seconds = duration / timescale;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}
