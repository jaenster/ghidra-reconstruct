#!/bin/bash
# build.sh <tree> <out-exe>: the zlib real-value round trip (design 7.5) against one emitted tree.
#   The tree's zlib TUs (and SSComp's ZLIB_* functions) and zlib 1.2.8 from ZLIB_SRC, both for
#   i686 Linux; run it with qemu-i386 <out-exe> [input files...]. One CASE line per case (same /
#   differs / crash, the tree run in a forked child); diff two trees' CASE lines for before/after.
#   Needs g++-i686-linux-gnu and qemu-user.
set -e
H=$(cd "$(dirname "$0")" && pwd); T=$(cd "$1" && pwd); OUT=$(realpath -m "$2"); Z=${ZLIB_SRC:-/Users/jaenster/code/re/diablo2/refs/zlib-1.2.8}
B=$(mktemp -d); trap "rm -rf $B" EXIT
cd "$T"; find . -type d ! -path '*/.git*' | sed "s|^\.|-I$T|" > $B/inc.rsp
CXX="i686-linux-gnu-g++ -std=c++17 -O1 -w -fms-extensions -fpermissive -ffunction-sections -fdata-sections -D_FILE_DEFINED -D__stdcall=__attribute__((stdcall)) -D__cdecl=__attribute__((cdecl)) -D__fastcall=__attribute__((fastcall)) -D__thiscall=__attribute__((thiscall)) -include $H/linux_compat.h @$B/inc.rsp"
for f in Storm/3rdparty/zlib/deflate.cpp Storm/3rdparty/zlib/trees.cpp Storm/3rdparty/zlib/inflate.cpp Storm/3rdparty/zlib/crc32.cpp Storm/3rdparty/zlib/zutil.cpp D2Client/Source/SSComp.cpp globals.Storm.cpp globals.cpp; do
  $CXX -c "$f" -o $B/$(echo $f | tr / _).o &
done
$CXX -I$H -c $H/tree_side.cpp -o $B/tree_side.o &
# The reference is configured as the original was built: for Win32, whose OS_CODE (zutil.h)
# is 0x0b. Built for Linux it writes 0x03 in byte 9 of every gzip header, and all W31 cases
# then "differ" in that one byte.
for f in adler32 crc32 deflate inflate inffast inftrees trees zutil; do i686-linux-gnu-gcc -O1 -w -DZ_PREFIX -DOS_CODE=0x0b -Dz_errmsg=ref_z_errmsg -ffunction-sections -fdata-sections -c $Z/$f.c -o $B/ref_$f.o & done
i686-linux-gnu-g++ -O1 -w -DZ_PREFIX -I$Z -I$H -c $H/ref_side.cpp -o $B/ref_side.o &
i686-linux-gnu-g++ -O1 -w -I$H -c $H/main.cpp -o $B/main.o &
wait
# A TU that failed to compile must not vanish into --unresolved-symbols=ignore-all: the
# tree side would then crash on every case and read as a broken zlib.
n=$(ls $B/*.o 2>/dev/null | wc -l); [ "$n" -eq 19 ] || { echo "build.sh: $n of 19 objects compiled" >&2; exit 1; }
i686-linux-gnu-g++ -static -Wl,--gc-sections -Wl,--unresolved-symbols=ignore-all $B/*.o -o "$OUT"
