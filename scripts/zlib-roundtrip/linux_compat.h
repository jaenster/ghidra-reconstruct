// Compile the tree's 32-bit code for i686 Linux (run under qemu-i386): the few Windows
// names d2_platform.h's non-Windows branch does not provide, and its one clash with the tree.
#include <cstdint>
typedef int errno_t;
typedef long __time32_t;
#define PRTL_CRITICAL_SECTION_DEBUG PRTL_CSD_platform_
#include "d2_platform.h"
#undef PRTL_CRITICAL_SECTION_DEBUG
struct _SERVICE_STATUS { uint32_t a[7]; };
typedef void* SERVICE_STATUS_HANDLE;
struct _SYSTEM_INFO { uint32_t a[9]; };
typedef void* HACCEL;
typedef void* LPCANDIDATELIST;
struct RGBQUAD { uint8_t b, g, r, x; };
struct _devicemodeA { uint8_t a[156]; };
struct _FLOATING_SAVE_AREA { uint32_t ControlWord, StatusWord, TagWord, ErrorOffset, ErrorSelector, DataOffset, DataSelector; uint8_t RegisterArea[80]; uint32_t Cr0NpxState; };
typedef _FLOATING_SAVE_AREA FLOATING_SAVE_AREA;
