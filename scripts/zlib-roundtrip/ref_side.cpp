#include <cstdlib>
#include <cstring>
#include <cstdint>
#include "zlib.h"
#define SIDE(x) ref_##x
#include "api.h"
#define STREAM z_stream
#define DEFLATE_INIT2(s, l, m, w, ml, st, v, sz) deflateInit2_(s, l, m, w, ml, st, v, sz)
#define DEFLATE_SETDICT(s, d, n) deflateSetDictionary(s, d, n)
#define DEFLATE(s, f) deflate(s, f)
#define DEFLATE_END(s) deflateEnd(s)
#define INFLATE_INIT2(s, w, v, sz) inflateInit2_(s, w, v, sz)
#define INFLATE(s, f) inflate(s, f)
#define INFLATE_SETDICT(s, d, n) inflateSetDictionary(s, d, n)
#define INFLATE_END(s) inflateEnd(s)
#include "side.inc"
