#include <cstdlib>
#include <cstring>
#include "Storm/3rdparty/zlib/deflate.h"
#include "Storm/3rdparty/zlib/inflate.h"
#define SIDE(x) tree_##x
#include "api.h"
namespace Fog::Debug { void GuardStack() {} }
namespace D = Storm::_3rdparty::zlib::deflate;
namespace I = Storm::_3rdparty::zlib::inflate;
#define STREAM z_stream
#define DEFLATE_INIT2(s, l, m, w, ml, st, v, sz) D::deflateInit2_(s, l, m, w, ml, st, v, sz)
#define DEFLATE_SETDICT(s, d, n) D::deflateSetDictionary(s, d, (uint8_t*)(uintptr_t)(n))
#define DEFLATE(s, f) D::deflate(s, (int*)(intptr_t)(f))
#define DEFLATE_END(s) D::deflateEnd(s)
#define INFLATE_INIT2(s, w, v, sz) I::inflateInit2_(s, w, v, sz)
#define INFLATE(s, f) I::inflate(s, f)
#define INFLATE_SETDICT(s, d, n) I::inflateSetDictionary(s, d, n)
#define INFLATE_END(s) I::inflateEnd(s)
#include "side.inc"
