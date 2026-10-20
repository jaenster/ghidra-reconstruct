
/* @function ZLIB_SendTree
   @address Game.exe.ram:0042be10
   @date 2026.06.12
   @params
     nMaxCode: ECX:4 (int32_t)
     nTree: EDX:4 (int32_t)
     nState: EAX:4 (int32_t)
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev
   
   Function uses custom registers for function arguments!
   [int32_t param_1@ECX:4]
   [int32_t param_2@EDX:4]
   [int32_t param_3@EAX:4] */

void __cdecl Storm::_3rdparty::zlib::trees::send_tree(int32_t nMaxCode,int32_t nTree,int32_t nState)

{
  byte byBitCount;
  int nBitBufLen;
  int nCount;
  uint nNextLen;
  uint nSymBitLen;
  int nRemaining;
  uint nPrevLen;
  ushort *pwTreeLen;
  uint nCurLen;
  int nMinRepeat;
  int nRepeatCount;
  ushort wCode;
  ushort wCode2;
  
  nPrevLen = 0xffffffff;
  nBitBufLen = 7;
  nMinRepeat = 4;
  if (*(ushort *)(nTree + 2) == 0) {
    nBitBufLen = 0x8a;
    nMinRepeat = 3;
  }
  if (-1 < nMaxCode) {
    pwTreeLen = (ushort *)(nTree + 6);
    nRemaining = nMaxCode + 1;
    nCount = 0;
    nCurLen = (uint)*(ushort *)(nTree + 2);
    do {
      nNextLen = (uint)*pwTreeLen;
      nRepeatCount = nCount + 1;
      if ((nBitBufLen <= nRepeatCount) || (nCurLen != nNextLen)) {
        if (nRepeatCount < nMinRepeat) {
          do {
            nSymBitLen = (uint)*(ushort *)(nState + 0xa7e + nCurLen * 4);
            nBitBufLen = *(int *)(nState + 0x16bc);
            if ((int)(0x10 - nSymBitLen) < nBitBufLen) {
              wCode = *(ushort *)(nState + 0xa7c + nCurLen * 4);
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | wCode << ((byte)nBitBufLen & 0x1f);
              *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
                   *(undefined1 *)(nState + 0x16b8);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
                   *(undefined1 *)(nState + 0x16b9);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              nBitBufLen = *(int *)(nState + 0x16bc) + -0x10;
              *(ushort *)(nState + 0x16b8) =
                   wCode >> (0x10U - (char)*(int *)(nState + 0x16bc) & 0x1f);
            }
            else {
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) |
                   *(short *)(nState + 0xa7c + nCurLen * 4) << ((byte)nBitBufLen & 0x1f);
            }
            nRepeatCount = nRepeatCount + -1;
            *(uint *)(nState + 0x16bc) = nBitBufLen + nSymBitLen;
          } while (nRepeatCount != 0);
        }
        else if (nCurLen == 0) {
          if (nRepeatCount < 0xb) {
            wCode = *(ushort *)(nState + 0xac2);
            byBitCount = (byte)*(int *)(nState + 0x16bc);
            if ((int)(0x10 - (uint)wCode) < *(int *)(nState + 0x16bc)) {
              wCode2 = *(ushort *)(nState + 0xac0);
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | wCode2 << (byBitCount & 0x1f);
              *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
                   *(undefined1 *)(nState + 0x16b8);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
                   *(undefined1 *)(nState + 0x16b9);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              nBitBufLen = *(int *)(nState + 0x16bc) + -0x10;
              *(ushort *)(nState + 0x16b8) =
                   wCode2 >> (0x10U - (char)*(int *)(nState + 0x16bc) & 0x1f);
            }
            else {
              nBitBufLen = *(int *)(nState + 0x16bc);
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | *(short *)(nState + 0xac0) << (byBitCount & 0x1f);
            }
            nBitBufLen = nBitBufLen + (uint)wCode;
            nCount = nCount + -2;
            *(int *)(nState + 0x16bc) = nBitBufLen;
            if (nBitBufLen < 0xe) {
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | (ushort)(nCount << ((byte)nBitBufLen & 0x1f));
              nBitBufLen = nBitBufLen + 3;
LAB_0042c33b:
              *(int *)(nState + 0x16bc) = nBitBufLen;
            }
            else {
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | (ushort)(nCount << ((byte)nBitBufLen & 0x1f));
              *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
                   *(undefined1 *)(nState + 0x16b8);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
                   *(undefined1 *)(nState + 0x16b9);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              nBitBufLen = *(int *)(nState + 0x16bc);
              *(int *)(nState + 0x16bc) = nBitBufLen + -0xd;
              *(ushort *)(nState + 0x16b8) = (ushort)nCount >> (0x10U - (char)nBitBufLen & 0x1f);
            }
          }
          else {
            wCode = *(ushort *)(nState + 0xac6);
            byBitCount = (byte)*(int *)(nState + 0x16bc);
            if ((int)(0x10 - (uint)wCode) < *(int *)(nState + 0x16bc)) {
              wCode2 = *(ushort *)(nState + 0xac4);
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | wCode2 << (byBitCount & 0x1f);
              *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
                   *(undefined1 *)(nState + 0x16b8);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
                   *(undefined1 *)(nState + 0x16b9);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              nBitBufLen = *(int *)(nState + 0x16bc) + -0x10;
              *(ushort *)(nState + 0x16b8) =
                   wCode2 >> (0x10U - (char)*(int *)(nState + 0x16bc) & 0x1f);
            }
            else {
              nBitBufLen = *(int *)(nState + 0x16bc);
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | *(short *)(nState + 0xac4) << (byBitCount & 0x1f);
            }
            nBitBufLen = nBitBufLen + (uint)wCode;
            nCount = nCount + -10;
            *(int *)(nState + 0x16bc) = nBitBufLen;
            if (nBitBufLen < 10) {
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | (ushort)(nCount << ((byte)nBitBufLen & 0x1f));
              nBitBufLen = nBitBufLen + 7;
              goto LAB_0042c33b;
            }
            *(ushort *)(nState + 0x16b8) =
                 *(ushort *)(nState + 0x16b8) | (ushort)(nCount << ((byte)nBitBufLen & 0x1f));
            *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
                 *(undefined1 *)(nState + 0x16b8);
            *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
            *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
                 *(undefined1 *)(nState + 0x16b9);
            *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
            nBitBufLen = *(int *)(nState + 0x16bc);
            *(int *)(nState + 0x16bc) = nBitBufLen + -9;
            *(ushort *)(nState + 0x16b8) = (ushort)nCount >> (0x10U - (char)nBitBufLen & 0x1f);
          }
        }
        else {
          if (nCurLen != nPrevLen) {
            nSymBitLen = (uint)*(ushort *)(nState + 0xa7e + nCurLen * 4);
            byBitCount = (byte)*(int *)(nState + 0x16bc);
            if ((int)(0x10 - nSymBitLen) < *(int *)(nState + 0x16bc)) {
              wCode = *(ushort *)(nState + 0xa7c + nCurLen * 4);
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) | wCode << (byBitCount & 0x1f);
              *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
                   *(undefined1 *)(nState + 0x16b8);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
                   *(undefined1 *)(nState + 0x16b9);
              *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
              nBitBufLen = *(int *)(nState + 0x16bc) + -0x10;
              *(ushort *)(nState + 0x16b8) =
                   wCode >> (0x10U - (char)*(int *)(nState + 0x16bc) & 0x1f);
            }
            else {
              nBitBufLen = *(int *)(nState + 0x16bc);
              *(ushort *)(nState + 0x16b8) =
                   *(ushort *)(nState + 0x16b8) |
                   *(short *)(nState + 0xa7c + nCurLen * 4) << (byBitCount & 0x1f);
            }
            *(uint *)(nState + 0x16bc) = nBitBufLen + nSymBitLen;
            nRepeatCount = nCount;
          }
          wCode = *(ushort *)(nState + 0xabe);
          byBitCount = (byte)*(int *)(nState + 0x16bc);
          if ((int)(0x10 - (uint)wCode) < *(int *)(nState + 0x16bc)) {
            wCode2 = *(ushort *)(nState + 0xabc);
            *(ushort *)(nState + 0x16b8) =
                 *(ushort *)(nState + 0x16b8) | wCode2 << (byBitCount & 0x1f);
            *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
                 *(undefined1 *)(nState + 0x16b8);
            *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
            *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
                 *(undefined1 *)(nState + 0x16b9);
            *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
            nBitBufLen = *(int *)(nState + 0x16bc) + -0x10;
            *(ushort *)(nState + 0x16b8) =
                 wCode2 >> (0x10U - (char)*(int *)(nState + 0x16bc) & 0x1f);
          }
          else {
            nBitBufLen = *(int *)(nState + 0x16bc);
            *(ushort *)(nState + 0x16b8) =
                 *(ushort *)(nState + 0x16b8) | *(short *)(nState + 0xabc) << (byBitCount & 0x1f);
          }
          nBitBufLen = nBitBufLen + (uint)wCode;
          nRepeatCount = nRepeatCount + -3;
          *(int *)(nState + 0x16bc) = nBitBufLen;
          if (nBitBufLen < 0xf) {
            *(ushort *)(nState + 0x16b8) =
                 *(ushort *)(nState + 0x16b8) | (ushort)(nRepeatCount << ((byte)nBitBufLen & 0x1f));
            nBitBufLen = nBitBufLen + 2;
            goto LAB_0042c33b;
          }
          *(ushort *)(nState + 0x16b8) =
               *(ushort *)(nState + 0x16b8) | (ushort)(nRepeatCount << ((byte)nBitBufLen & 0x1f));
          *(undefined1 *)(*(int *)(nState + 8) + *(int *)(nState + 0x14)) =
               *(undefined1 *)(nState + 0x16b8);
          *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
          *(undefined1 *)(*(int *)(nState + 0x14) + *(int *)(nState + 8)) =
               *(undefined1 *)(nState + 0x16b9);
          *(int *)(nState + 0x14) = *(int *)(nState + 0x14) + 1;
          nBitBufLen = *(int *)(nState + 0x16bc);
          *(int *)(nState + 0x16bc) = nBitBufLen + -0xe;
          *(ushort *)(nState + 0x16b8) = (ushort)nRepeatCount >> (0x10U - (char)nBitBufLen & 0x1f);
        }
        nRepeatCount = 0;
        nPrevLen = nCurLen;
        if (nNextLen == 0) {
          nBitBufLen = 0x8a;
          nMinRepeat = 3;
        }
        else if (nCurLen == nNextLen) {
          nBitBufLen = 6;
          nMinRepeat = 3;
        }
        else {
          nBitBufLen = 7;
          nMinRepeat = 4;
        }
      }
      pwTreeLen = pwTreeLen + 2;
      nRemaining = nRemaining + -1;
      nCount = nRepeatCount;
      nCurLen = nNextLen;
    } while (nRemaining != 0);
  }
  return;
}


