// The body of both sides, over a z_stream type STREAM and the six entry points, as macros.
static void* za(void* o, uint32_t n, uint32_t s) { (void)o; return calloc(n, s); }
static void zf(void* o, void* p) { (void)o; free(p); }

int SIDE(deflate)(const unsigned char* in, unsigned inLen, unsigned char* out, unsigned outCap, unsigned* outLen,
                  int level, int windowBits, int memLevel, int strategy, unsigned ichunk, unsigned ochunk, int midFlush,
                  const unsigned char* dict, unsigned dictLen) {
  STREAM s; memset(&s, 0, sizeof s);
  s.zalloc = (decltype(s.zalloc))za; s.zfree = (decltype(s.zfree))zf;
  int r = (int)DEFLATE_INIT2(&s, level, 8, windowBits, memLevel, strategy, (char*)"1.2.8", (int)sizeof s);
  if (r) return r;
  if (dict && (r = (int)DEFLATE_SETDICT(&s, (unsigned char*)dict, dictLen))) return r;
  unsigned pos = 0, opos = 0;
  int ret = 0;
  for (;;) {
    unsigned n = inLen - pos < ichunk ? inLen - pos : ichunk;
    int last = pos + n >= inLen;
    s.next_in = (unsigned char*)in + pos; s.avail_in = n; pos += n;
    int fl = last ? 4 : midFlush;
    do {
      unsigned room = outCap - opos < ochunk ? outCap - opos : ochunk;
      if (!room) { ret = -100; break; }
      s.next_out = out + opos; s.avail_out = room;
      r = (int)DEFLATE(&s, fl);
      opos += room - s.avail_out;
      if (r < 0 && r != -5) { ret = r; break; }
      if (r == 1) break;
    } while (s.avail_out == 0 || s.avail_in != 0);
    if (ret || last) break;
  }
  *outLen = opos;
  DEFLATE_END(&s);
  return ret;
}

int SIDE(inflate)(const unsigned char* in, unsigned inLen, unsigned char* out, unsigned outCap, unsigned* outLen,
                  int windowBits, unsigned ichunk, unsigned ochunk, const unsigned char* dict, unsigned dictLen, char* msg) {
  STREAM s; memset(&s, 0, sizeof s);
  s.zalloc = (decltype(s.zalloc))za; s.zfree = (decltype(s.zfree))zf;
  msg[0] = 0;
  int r = (int)INFLATE_INIT2(&s, windowBits, (char*)"1.2.8", (int)sizeof s);
  if (r) return r;
  unsigned pos = 0, opos = 0;
  int guard = 0;
  for (;;) {
    if (++guard > 10000000) { r = -101; break; }
    if (s.avail_in == 0 && pos < inLen) { unsigned n = inLen - pos < ichunk ? inLen - pos : ichunk; s.next_in = (unsigned char*)in + pos; s.avail_in = n; pos += n; }
    unsigned room = outCap - opos < ochunk ? outCap - opos : ochunk;
    if (!room) { r = -100; break; }
    s.next_out = out + opos; s.avail_out = room;
    r = (int)INFLATE(&s, 0);
    opos += room - s.avail_out;
    if (r == 2 && dict) { r = (int)INFLATE_SETDICT(&s, (unsigned char*)dict, dictLen); if (r) break; continue; }
    if (r == 1 || (r < 0 && r != -5)) break;
    if (r == -5 && pos >= inLen && s.avail_in == 0) break;
    if (r == 2) break;
  }
  if (s.msg) { strncpy(msg, (const char*)s.msg, 127); msg[127] = 0; }
  *outLen = opos;
  INFLATE_END(&s);
  return r;
}
