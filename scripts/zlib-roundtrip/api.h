// One side of the zlib round trip: the tree's rebuilt zlib or the reference zlib 1.2.8.
#ifdef __cplusplus
extern "C" {
#endif
// Compress `in` in input pieces of `ichunk` bytes (flush `midFlush` between pieces, Z_FINISH
// at the end), handing out output space `ochunk` bytes at a time. Returns 0, or the first
// unexpected return code (negative); *outLen gets the bytes written.
int SIDE(deflate)(const unsigned char* in, unsigned inLen, unsigned char* out, unsigned outCap, unsigned* outLen,
                  int level, int windowBits, int memLevel, int strategy, unsigned ichunk, unsigned ochunk, int midFlush,
                  const unsigned char* dict, unsigned dictLen);
// Decompress likewise; returns the last return code of inflate (1 = Z_STREAM_END), with
// the stream's msg copied to `msg` (or "" when none).
int SIDE(inflate)(const unsigned char* in, unsigned inLen, unsigned char* out, unsigned outCap, unsigned* outLen,
                  int windowBits, unsigned ichunk, unsigned ochunk, const unsigned char* dict, unsigned dictLen, char* msg);
#ifdef __cplusplus
}
#endif
