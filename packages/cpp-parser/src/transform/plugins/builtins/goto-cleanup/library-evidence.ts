/**
 * E1 evidence (design 3.2): library code whose source is public, read against the shipped
 * version's own text. Game.exe links zlib 1.2.8 (`refs/zlib-1.2.8`, design 2.7); where the
 * source writes a block at several places and MSVC merged the copies into one block with
 * jumps to it, copying the block back to each jump restores the source. Where the source
 * has a goto, the jump keeps it, under the source's own label name.
 *
 * Keyed by Ghidra's label name, which carries the block's 1.14d address and so is unique
 * across the binary. Every entry cites the source lines it rests on; `zlib-oracle.ts`
 * checks the result against the source's own goto counts (design 7.4).
 *
 * This table is evidence about the binary, not a rewrite: an entry only licenses what the
 * structurer proposes, and the validator still proves every copy.
 */

export interface LibraryLabelFact {
  /** 1.14d address of the function holding the label. */
  fn: string;
  /** The library function (zlib 1.2.8 name). */
  libFn: string;
  /** The block at the label is written at every jump's site in the source: file:lines and what. */
  copied?: string;
  /**
   * The statements right BEFORE the label (the join of the if ahead of it) are written at
   * the end of each of that if's arms in the source: sinking them restores the source, and
   * the jump then only skips.
   */
  join?: string;
  /** Work nodes of the block (`copied`) or join (`join`) the source writes at each site: a copy of anything else is not licensed. */
  work?: number;
  /**
   * The jump is one the source writes as a test it repeats: MSVC threaded the second
   * evaluation into the first's arms (`if (a && c) T; if (c) ..` compiled so that the
   * `c` path of the first if jumps past the second test). Re-testing restores the source
   * (design 5, T4 - admitted only with this evidence).
   */
  rethreaded?: string;
  /** The source's own goto label for this target: the jump stays, under this name. */
  sourceLabel?: string;
}

const ZLIB = 'zlib 1.2.8';

export const LIBRARY_LABELS: Readonly<Record<string, LibraryLabelFact>> = {
  // deflate() 00428c60: each gzip header state ends `s->status = NEXT_STATE` in both arms.
  LAB_00429052: { fn: '00428c60', libFn: 'deflate', join: `${ZLIB} deflate.c:787,791 s->status = NAME_STATE in both arms of if (s->gzhead->extra != Z_NULL)`, work: 1 },
  LAB_00429108: { fn: '00428c60', libFn: 'deflate', join: `${ZLIB} deflate.c:818,822 s->status = COMMENT_STATE in both arms of if (s->gzhead->name != Z_NULL)`, work: 1 },
  LAB_004291ba: { fn: '00428c60', libFn: 'deflate', join: `${ZLIB} deflate.c:848,851 s->status = HCRC_STATE in both arms of if (s->gzhead->comment != Z_NULL)`, work: 1 },
  LAB_00429219: { fn: '00428c60', libFn: 'deflate', join: `${ZLIB} deflate.c:861,865 s->status = BUSY_STATE in both arms of if (s->gzhead->hcrc)`, work: 1 },
  LAB_004292b9: { fn: '00428c60', libFn: 'deflate', rethreaded: `${ZLIB} deflate.c:893,899 if (s->status == FINISH_STATE && strm->avail_in != 0) ERR_RETURN; if (strm->avail_in != 0 || s->lookahead != 0 || ..)` },
  LAB_004293b8: { fn: '00428c60', libFn: 'deflate', rethreaded: `${ZLIB} deflate.c:899-900 the block-start test, entered from the FINISH_STATE check` },
  // inflateSetDictionary() 0042b220
  LAB_0042b28d: { fn: '0042b220', libFn: 'inflateSetDictionary', rethreaded: `${ZLIB} inflate.c:1303,1307 if (state->wrap != 0 && state->mode != DICT) return; if (state->mode == DICT) {..}` },
  // send_tree() 0042be10: send_bits()'s else arm, expanded at every send_code/send_bits.
  LAB_0042c33b: { fn: '0042be10', libFn: 'send_tree', copied: `${ZLIB} trees.c:223 send_bits() macro, s->bi_valid += len, in each expansion`, work: 1 },
  // _tr_flush_block() 0042d250
  LAB_0042d2c3: { fn: '0042d250', libFn: '_tr_flush_block', join: `${ZLIB} trees.c:948,952 opt_lenb = static_lenb in both arms of if (s->level > 0)`, work: 1 },
  // inflate_fast() 0042dca0
  LAB_0042dfb2: { fn: '0042dca0', libFn: 'inflate_fast', copied: `${ZLIB} inffast.c:224,242,253 from = out - dist, after each window copy`, work: 1 },
  LAB_0042e06c: { fn: '0042dca0', libFn: 'inflate_fast', copied: `${ZLIB} inffast.c:137,265,279 PUP(out) = .., the literal and each last copied byte`, work: 2 },
  LAB_0042e0b8: { fn: '0042dca0', libFn: 'inflate_fast', copied: `${ZLIB} inffast.c:179,289,304 state->mode = BAD; break;`, work: 4 },
  // inflate() 00429bb0
  LAB_0042af57: { fn: '00429bb0', libFn: 'inflate', copied: `${ZLIB} inflate.c state->mode = BAD; break; at each error (663-1203)`, work: 2 },
  LAB_0042afba: { fn: '00429bb0', libFn: 'inflate', sourceLabel: 'inf_leave' },
};

/** The fact for a label, or null. */
export function libraryLabel(label: string | null | undefined): LibraryLabelFact | null {
  if (!label) return null;
  return LIBRARY_LABELS[label] ?? null;
}
