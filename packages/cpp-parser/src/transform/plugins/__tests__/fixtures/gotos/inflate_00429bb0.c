
/* @function ZLIB_Inflate
   @address Game.exe.ram:00429bb0
   @date 2026.06.13
   @calling __fastcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

int32_t __fastcall Storm::_3rdparty::zlib::inflate::inflate(z_stream *pInflateStream,int32_t nFlush)

{
  void *pvVar1;
  int nHeadHave;
  uint *pNextInCur;
  byte *pFrom;
  uint32_t pInTmp;
  BOOL nTmp;
  int pNextInTmp;
  uint32_t nAvailInStart;
  byte byShift3;
  byte byShift;
  char byOp;
  ushort nLenVal;
  uint eState;
  uint nScratch;
  uint32_t nHold;
  uint32_t nBits;
  uint32_t nFrom;
  int nRet;
  uint32_t nAvailOutStart;
  byte *pNextOut;
  char abHdrScratch;
  undefined1 byHdr1;
  undefined1 byHdr2;
  undefined1 byHdr3;
  uint nAvailOut;
  uint32_t pHere;
  z_stream *pStrm;
  uint nCopy;
  uint *pNextIn;
  uint32_t nAvailIn;
  inflate_state *pState;
  z_stream *pStrm2;
  
  if ((((pInflateStream == (z_stream *)0x0) ||
       (pState = pInflateStream->state, pState == (inflate_state *)0x0)) ||
      (pInflateStream->next_out == (byte *)0x0)) ||
     ((pInflateStream->next_in == (byte *)0x0 && (pInflateStream->avail_in != 0)))) {
    return -2;
  }
  if (pState->mode == 0xb) {
    pState->mode = 0xc;
  }
  pNextOut = pInflateStream->next_out;
  nAvailOutStart = pInflateStream->avail_out;
  pNextIn = (uint *)pInflateStream->next_in;
  nAvailInStart = pInflateStream->avail_in;
  nHold = pState->hold;
  eState = pState->mode;
  nBits = pState->bits;
  nRet = 0;
  nAvailOut = nAvailOutStart;
  pHere = nHold;
  pStrm = pInflateStream;
  nAvailIn = nAvailInStart;
  if (0x1e < eState) {
    return -2;
  }
  do {
    pNextInCur = pNextIn;
                    /* WARNING: Switch is manually overridden */
    switch(eState) {
    case 0:
      if (pState->wrap == 0) {
        pState->mode = 0xc;
      }
      else {
        for (; pNextIn = pNextInCur, nBits < 0x10; nBits = nBits + 8) {
          if (nAvailIn == 0) goto LAB_0042afba;
          nAvailIn = nAvailIn - 1;
          nHold = nHold + ((uint)(byte)*pNextInCur << ((byte)nBits & 0x1f));
          pHere = nHold;
          pNextInCur = (uint *)((int)pNextInCur + 1);
        }
        if (((pState->wrap & 2) == 0) || (nHold != 0x8b1f)) {
          pState->flags = 0;
          if (pState->head != (void *)0x0) {
            *(undefined4 *)((int)pState->head + 0x30) = 0xffffffff;
          }
          if (((pState->wrap & 1) == 0) || (((nHold & 0xff) * 0x100 + (nHold >> 8)) % 0x1f != 0)) {
            pStrm->msg = "incorrect header check";
          }
          else {
            if (((byte)nHold & 0xf) == 8) {
              pHere = nHold >> 4;
              nBits = nBits - 4;
              eState = (pHere & 0xf) + 8;
              if (pState->wbits == 0) {
                pState->wbits = eState;
              }
              else if (pState->wbits < eState) {
                pStrm->msg = "invalid window size";
                nHold = pHere;
                goto LAB_0042af57;
              }
              pState->dmax = 1 << (sbyte)eState;
              nBits = D2Client::Source::SSComp::ZLIB_Adler32(0,(byte *)0x0,0);
              pState->check = nBits;
              pStrm->adler = nBits;
              pState->mode = ~(nHold >> 0xc) & 2 | 9;
              nHold = 0;
              pHere = 0;
              nBits = 0;
              break;
            }
            pStrm->msg = "unknown compression method";
          }
          goto LAB_0042af57;
        }
        nHold = Storm::_3rdparty::zlib::crc32::crc32(0,(uint *)0x0,0);
        pState->check = nHold;
        abHdrScratch = '\x1f';
        byHdr1 = 0x8b;
        nBits = Storm::_3rdparty::zlib::crc32::crc32(pState->check,(uint *)&abHdrScratch,2);
        nHold = 0;
        pState->check = nBits;
        pHere = 0;
        nBits = 0;
        pState->mode = 1;
      }
      break;
    case 1:
      for (; pNextIn = pNextInCur, nBits < 0x10; nBits = nBits + 8) {
        if (nAvailIn == 0) goto LAB_0042afba;
        eState = *pNextInCur;
        nAvailIn = nAvailIn - 1;
        pNextInCur = (uint *)((int)pNextInCur + 1);
        nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
        pHere = nHold;
      }
      pState->flags = nHold;
      if ((char)nHold == '\b') {
        if ((nHold & 0xe000) == 0) {
          if (pState->head != (uint *)0x0) {
            *(uint32_t *)pState->head = nHold >> 8 & 1;
          }
          if ((pState->flags & 0x200U) != 0) {
            byHdr1 = (undefined1)(nHold >> 8);
            abHdrScratch = (char)nHold;
            nHold = Storm::_3rdparty::zlib::crc32::crc32(pState->check,(uint *)&abHdrScratch,2);
            pState->check = nHold;
          }
          nHold = 0;
          nBits = 0;
          pState->mode = 2;
          do {
            pNextInCur = pNextIn;
            if (nAvailIn == 0) goto LAB_0042afba;
            eState = *pNextIn;
            nAvailIn = nAvailIn - 1;
            byShift = (byte)nBits;
            pNextIn = (uint *)((int)pNextIn + 1);
            nBits = nBits + 8;
            nHold = nHold + ((uint)(byte)eState << (byShift & 0x1f));
joined_r0x00429e3b:
          } while (nBits < 0x20);
          if (pState->head != (void *)0x0) {
            *(uint32_t *)((int)pState->head + 4) = nHold;
          }
          if ((pState->flags & 0x200U) != 0) {
            abHdrScratch = (char)nHold;
            byHdr1 = (undefined1)(nHold >> 8);
            byHdr2 = (undefined1)(nHold >> 0x10);
            byHdr3 = (undefined1)(nHold >> 0x18);
            nHold = Storm::_3rdparty::zlib::crc32::crc32(pState->check,(uint *)&abHdrScratch,4);
            pState->check = nHold;
          }
          nHold = 0;
          nBits = 0;
          pState->mode = 3;
          do {
            pNextInCur = pNextIn;
            if (nAvailIn == 0) goto LAB_0042afba;
            eState = *pNextIn;
            nAvailIn = nAvailIn - 1;
            byShift = (byte)nBits;
            pNextIn = (uint *)((int)pNextIn + 1);
            nBits = nBits + 8;
            nHold = nHold + ((uint)(byte)eState << (byShift & 0x1f));
joined_r0x00429eb3:
          } while (nBits < 0x10);
          if (pState->head != (void *)0x0) {
            *(uint32_t *)((int)pState->head + 8) = nHold & 0xff;
            *(uint32_t *)((int)pState->head + 0xc) = nHold >> 8;
          }
          if ((pState->flags & 0x200U) != 0) {
            abHdrScratch = (char)nHold;
            byHdr1 = (undefined1)(nHold >> 8);
            nHold = Storm::_3rdparty::zlib::crc32::crc32(pState->check,(uint *)&abHdrScratch,2);
            pState->check = nHold;
          }
          nHold = 0;
          pHere = 0;
          nBits = 0;
          pState->mode = 4;
          goto switchD_00429c46_caseD_429f29;
        }
        pStrm->msg = "unknown header flags set";
      }
      else {
        pStrm->msg = "unknown compression method";
      }
      goto LAB_0042af57;
    case 2:
      goto joined_r0x00429e3b;
    case 3:
      goto joined_r0x00429eb3;
    case 4:
switchD_00429c46_caseD_429f29:
      if ((pState->flags & 0x400U) == 0) {
        if (pState->head != (void *)0x0) {
          *(undefined4 *)((int)pState->head + 0x10) = 0;
        }
      }
      else {
        for (; nBits < 0x10; nBits = nBits + 8) {
          pNextInCur = pNextIn;
          if (nAvailIn == 0) goto LAB_0042afba;
          eState = *pNextIn;
          nAvailIn = nAvailIn - 1;
          pNextIn = (uint *)((int)pNextIn + 1);
          nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
        }
        pState->length = nHold;
        if (pState->head != (void *)0x0) {
          *(uint32_t *)((int)pState->head + 0x14) = nHold;
        }
        if ((pState->flags & 0x200U) != 0) {
          abHdrScratch = (char)nHold;
          byHdr1 = (undefined1)(nHold >> 8);
          nHold = Storm::_3rdparty::zlib::crc32::crc32(pState->check,(uint *)&abHdrScratch,2);
          pState->check = nHold;
        }
        nHold = 0;
        pHere = 0;
        nBits = 0;
      }
      pState->mode = 5;
    case 5:
      if ((pState->flags & 0x400U) == 0) {
LAB_0042a054:
        pState->length = 0;
        pState->mode = 6;
switchD_00429c46_caseD_42a061:
        if ((pState->flags & 0x800U) == 0) {
          if (pState->head != (void *)0x0) {
            *(undefined4 *)((int)pState->head + 0x1c) = 0;
          }
LAB_0042a107:
          pState->length = 0;
          pState->mode = 7;
switchD_00429c46_caseD_42a114:
          if ((pState->flags & 0x1000U) == 0) {
            if (pState->head != (void *)0x0) {
              *(undefined4 *)((int)pState->head + 0x24) = 0;
            }
LAB_0042a1b7:
            pState->mode = 8;
switchD_00429c46_caseD_42a1bd:
            if ((pState->flags & 0x200U) != 0) {
              for (; nBits < 0x10; nBits = nBits + 8) {
                pNextInCur = pNextIn;
                if (nAvailIn == 0) goto LAB_0042afba;
                eState = *pNextIn;
                nAvailIn = nAvailIn - 1;
                pNextIn = (uint *)((int)pNextIn + 1);
                nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
                pHere = nHold;
              }
              if (nHold != (ushort)pState->check) {
                pStrm->msg = "header crc mismatch";
                goto LAB_0042af57;
              }
              nHold = 0;
              pHere = 0;
              nBits = 0;
            }
            if (pState->head != (void *)0x0) {
              *(uint *)((int)pState->head + 0x2c) = pState->flags >> 9 & 1;
              *(undefined4 *)((int)pState->head + 0x30) = 1;
            }
            pInTmp = Storm::_3rdparty::zlib::crc32::crc32(0,(uint *)0x0,0);
            pState->check = pInTmp;
            pStrm->adler = pInTmp;
LAB_0042a247:
            pState->mode = 0xb;
            break;
          }
          pNextInCur = pNextIn;
          if (nAvailIn != 0) {
            nCopy = 0;
            do {
              byOp = *(char *)(nCopy + (int)pNextIn);
              nCopy = nCopy + 1;
              pvVar1 = pState->head;
              if (((pvVar1 != (void *)0x0) && (*(int *)((int)pvVar1 + 0x24) != 0)) &&
                 (pState->length < *(uint *)((int)pvVar1 + 0x28))) {
                *(char *)(*(int *)((int)pvVar1 + 0x24) + pState->length) = byOp;
                pState->length = pState->length + 1;
              }
            } while ((byOp != '\0') && (nCopy < nAvailIn));
            if ((pState->flags & 0x200U) != 0) {
              pInTmp = Storm::_3rdparty::zlib::crc32::crc32(pState->check,pNextIn,nCopy);
              pState->check = pInTmp;
            }
            nAvailIn = nAvailIn - nCopy;
            pNextIn = (uint *)((int)pNextIn + nCopy);
            pNextInCur = pNextIn;
            if (byOp == '\0') goto LAB_0042a1b7;
          }
        }
        else {
          pNextInCur = pNextIn;
          if (nAvailIn != 0) {
            nCopy = 0;
            do {
              byOp = *(char *)(nCopy + (int)pNextIn);
              nCopy = nCopy + 1;
              pvVar1 = pState->head;
              if (((pvVar1 != (void *)0x0) && (*(int *)((int)pvVar1 + 0x1c) != 0)) &&
                 (pState->length < *(uint *)((int)pvVar1 + 0x20))) {
                *(char *)(*(int *)((int)pvVar1 + 0x1c) + pState->length) = byOp;
                pState->length = pState->length + 1;
              }
            } while ((byOp != '\0') && (nCopy < nAvailIn));
            if ((pState->flags & 0x200U) != 0) {
              pInTmp = Storm::_3rdparty::zlib::crc32::crc32(pState->check,pNextIn,nCopy);
              pState->check = pInTmp;
            }
            nAvailIn = nAvailIn - nCopy;
            pNextIn = (uint *)((int)pNextIn + nCopy);
            pNextInCur = pNextIn;
            if (byOp == '\0') goto LAB_0042a107;
          }
        }
      }
      else {
        nCopy = pState->length;
        if (nAvailIn < pState->length) {
          nCopy = nAvailIn;
        }
        if (nCopy != 0) {
          if ((pState->head != (void *)0x0) &&
             (pNextInTmp = *(int *)((int)pState->head + 0x10), pNextInTmp != 0)) {
            nHeadHave = *(int *)((int)pState->head + 0x14) - pState->length;
            eState = *(uint *)((int)pState->head + 0x18);
            nScratch = nCopy;
            if (eState < nHeadHave + nCopy) {
              nScratch = eState - nHeadHave;
            }
            compiler::_memcpy((void *)(pNextInTmp + nHeadHave),pNextIn,nScratch);
          }
          if ((pState->flags & 0x200U) != 0) {
            pInTmp = Storm::_3rdparty::zlib::crc32::crc32(pState->check,pNextIn,nCopy);
            pState->check = pInTmp;
          }
          nAvailIn = nAvailIn - nCopy;
          pNextIn = (uint *)((int)pNextIn + nCopy);
          pState->length = pState->length - nCopy;
        }
        pNextInCur = pNextIn;
        if (pState->length == 0) goto LAB_0042a054;
      }
LAB_0042afba:
      pStrm->next_out = pNextOut;
      pStrm->next_in = (byte *)pNextInCur;
      pStrm->avail_out = nAvailOut;
      pStrm->avail_in = nAvailIn;
      pState->hold = nHold;
      pState->bits = nBits;
      if (((pState->wsize == 0) &&
          (((nAvailOutStart == pStrm->avail_out || (0x1c < pState->mode)) ||
           ((0x19 < pState->mode && (nFlush == 4)))))) ||
         (nTmp = Storm::_3rdparty::zlib::inflate::updatewindow
                           (nAvailOutStart - pStrm->avail_out,(int32_t)pStrm->next_out,pStrm),
         nTmp == 0)) {
        pStrm2 = pStrm;
        pNextInTmp = nAvailInStart - pStrm->avail_in;
        nAvailOutStart = nAvailOutStart - pStrm->avail_out;
        pStrm->total_in = pStrm->total_in + pNextInTmp;
        pStrm->total_out = pStrm->total_out + nAvailOutStart;
        pState->total = pState->total + nAvailOutStart;
        if ((pState->wrap != 0) && (nAvailOutStart != 0)) {
          if (pState->flags == 0) {
            nAvailInStart =
                 D2Client::Source::SSComp::ZLIB_Adler32
                           (pState->check,pStrm->next_out + -nAvailOutStart,nAvailOutStart);
          }
          else {
            nAvailInStart =
                 Storm::_3rdparty::zlib::crc32::crc32
                           (pState->check,(uint *)(pStrm->next_out + -nAvailOutStart),nAvailOutStart
                           );
          }
          pState->check = nAvailInStart;
          pStrm2->adler = nAvailInStart;
        }
        nHeadHave = pState->mode;
        if ((nHeadHave == 0x13) || (nFrom = 0, nHeadHave == 0xe)) {
          nFrom = 0x100;
        }
        pStrm2->data_type =
             ((nHeadHave != 0xb) - 1 & 0x80) + (-(uint)(pState->last != 0) & 0x40) + nFrom +
             pState->bits;
        if (((pNextInTmp != 0) || (nAvailOutStart != 0)) && (nFlush != 4)) {
          return nRet;
        }
        if (nRet != 0) {
          return nRet;
        }
        return -5;
      }
      pState->mode = 0x1e;
switchD_00429c46_caseD_42b013:
      return -4;
    case 6:
      goto switchD_00429c46_caseD_42a061;
    case 7:
      goto switchD_00429c46_caseD_42a114;
    case 8:
      goto switchD_00429c46_caseD_42a1bd;
    case 9:
      for (; nBits < 0x20; nBits = nBits + 8) {
        pNextInCur = pNextIn;
        if (nAvailIn == 0) goto LAB_0042afba;
        eState = *pNextIn;
        nAvailIn = nAvailIn - 1;
        pNextIn = (uint *)((int)pNextIn + 1);
        nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
        pHere = nHold;
      }
      nHold = ((nHold & 0xff00) + nHold * 0x10000) * 0x100 + (pHere >> 0x10 & 0xff) * 0x100 +
              (nHold >> 0x18);
      pState->check = nHold;
      pStrm->adler = nHold;
      nHold = 0;
      nBits = 0;
      pState->mode = 10;
    case 10:
      if (pState->havedict == 0) {
        pStrm->next_out = pNextOut;
        pStrm->avail_out = nAvailOut;
        pStrm->next_in = (byte *)pNextIn;
        pStrm->avail_in = nAvailIn;
        pState->bits = nBits;
        pState->hold = nHold;
        return 2;
      }
      pInTmp = D2Client::Source::SSComp::ZLIB_Adler32(0,(byte *)0x0,0);
      pState->check = pInTmp;
      pStrm->adler = pInTmp;
      pState->mode = 0xb;
switchD_00429c46_caseD_42a2df:
      pNextInCur = pNextIn;
      if ((nFlush == 5) || (nFlush == 6)) goto LAB_0042afba;
switchD_00429c46_caseD_42a2f3:
      pNextInCur = pNextIn;
      if (pState->last != 0) {
        nHold = nHold >> (sbyte)(nBits & 7);
        nBits = nBits - (nBits & 7);
        pState->mode = 0x1a;
        pHere = nHold;
        break;
      }
      for (; pNextIn = pNextInCur, nBits < 3; nBits = nBits + 8) {
        if (nAvailIn == 0) goto LAB_0042afba;
        nAvailIn = nAvailIn - 1;
        nHold = nHold + ((uint)(byte)*pNextInCur << ((byte)nBits & 0x1f));
        pNextInCur = (uint *)((int)pNextInCur + 1);
      }
      pState->last = nHold & 1;
      switch(nHold >> 1 & 3) {
      case 0:
        nHold = nHold >> 3;
        pState->mode = 0xd;
        nBits = nBits - 3;
        pHere = nHold;
        goto LAB_0042af5d;
      case 1:
        pState->lencode = gaZlibInflateTableMid;
        pState->lenbits = 9;
        pState->distcode = gaZlibInflateTableStart;
        pState->distbits = 5;
        pState->mode = 0x13;
        if (nFlush == 6) {
          nHold = nHold >> 3;
          nBits = nBits - 3;
          goto LAB_0042afba;
        }
        break;
      case 2:
        nHold = nHold >> 3;
        pState->mode = 0x10;
        nBits = nBits - 3;
        pHere = nHold;
        goto LAB_0042af5d;
      case 3:
        pStrm->msg = "invalid block type";
        pState->mode = 0x1d;
      }
      nHold = nHold >> 3;
      nBits = nBits - 3;
      pHere = nHold;
      break;
    case 0xb:
      goto switchD_00429c46_caseD_42a2df;
    case 0xc:
      goto switchD_00429c46_caseD_42a2f3;
    case 0xd:
      nHold = nHold >> (sbyte)(nBits & 7);
      for (nBits = nBits - (nBits & 7); pNextInCur = pNextIn, pHere = nHold, nBits < 0x20;
          nBits = nBits + 8) {
        if (nAvailIn == 0) goto LAB_0042afba;
        eState = *pNextIn;
        nAvailIn = nAvailIn - 1;
        pNextIn = (uint *)((int)pNextIn + 1);
        nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
      }
      eState = nHold & 0xffff;
      if (eState == ~nHold >> 0x10) {
        nHold = 0;
        nBits = 0;
        pState->length = eState;
        pHere = 0;
        pState->mode = 0xe;
        if (nFlush != 6) goto switchD_00429c46_caseD_42a446;
        goto LAB_0042afba;
      }
      pStrm->msg = "invalid stored block lengths";
      goto LAB_0042af57;
    case 0xe:
switchD_00429c46_caseD_42a446:
      pState->mode = 0xf;
    case 0xf:
      nCopy = pState->length;
      if (nCopy == 0) goto LAB_0042a247;
      if (nAvailIn < nCopy) {
        nCopy = nAvailIn;
      }
      if (nAvailOut < nCopy) {
        nCopy = nAvailOut;
      }
      pNextInCur = pNextIn;
      if (nCopy != 0) {
        compiler::_memcpy(pNextOut,pNextIn,nCopy);
        nAvailIn = nAvailIn - nCopy;
        nAvailOut = nAvailOut - nCopy;
        pNextOut = pNextOut + nCopy;
        pState->length = pState->length - nCopy;
        pNextIn = (uint *)((int)pNextIn + nCopy);
        break;
      }
      goto LAB_0042afba;
    case 0x10:
      for (; nBits < 0xe; nBits = nBits + 8) {
        pNextInCur = pNextIn;
        if (nAvailIn == 0) goto LAB_0042afba;
        eState = *pNextIn;
        nAvailIn = nAvailIn - 1;
        pNextIn = (uint *)((int)pNextIn + 1);
        nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
      }
      pState->nlen = (nHold & 0x1f) + 0x101;
      nScratch = nHold >> 10;
      eState = (nHold >> 5 & 0x1f) + 1;
      nHold = nHold >> 0xe;
      nBits = nBits - 0xe;
      pState->ndist = eState;
      pState->ncode = (nScratch & 0xf) + 4;
      pHere = nHold;
      if ((pState->nlen < 0x11f) && (eState < 0x1f)) {
        pState->have = 0;
        pState->mode = 0x11;
        goto switchD_00429c46_caseD_42a52b;
      }
      pStrm->msg = "too many length or distance symbols";
      goto LAB_0042af57;
    case 0x11:
switchD_00429c46_caseD_42a52b:
      pNextInCur = pNextIn;
      if (pState->have < pState->ncode) {
        do {
          for (; nBits < 3; nBits = nBits + 8) {
            if (nAvailIn == 0) goto LAB_0042afba;
            nAvailIn = nAvailIn - 1;
            pNextIn = (uint *)((int)pNextInCur + 1);
            nHold = nHold + ((uint)(byte)*pNextInCur << ((byte)nBits & 0x1f));
            pNextInCur = pNextIn;
          }
          pState->lens[gwZlibInflateWindow[pState->have]] = (ushort)nHold & 7;
          pState->have = pState->have + 1;
          nHold = nHold >> 3;
          nBits = nBits - 3;
          pHere = nHold;
        } while (pState->have < pState->ncode);
      }
      eState = pState->have;
      while (eState < 0x13) {
        pState->lens[gwZlibInflateWindow[pState->have]] = 0;
        pState->have = pState->have + 1;
        eState = pState->have;
      }
      pState->next = pState + 1;
      pState->lencode = pState + 1;
      pState->lenbits = 7;
      nRet = D2Client::Source::SSComp::ZLIB_InflateTable
                       (0,(int32_t)pState->lens,0x13,(int *)&pState->next,&pState->lenbits,
                        pState->work);
      if (nRet == 0) {
        pState->have = 0;
        pState->mode = 0x12;
        goto switchD_00429c46_caseD_42a61a;
      }
      pStrm->msg = "invalid code lengths set";
LAB_0042af57:
      pState->mode = 0x1d;
      break;
    case 0x12:
switchD_00429c46_caseD_42a61a:
      pNextInCur = pNextIn;
      if (pState->have < pState->ndist + pState->nlen) {
        do {
          pHere = *(uint *)((int)pState->lencode +
                           ((1 << ((byte)pState->lenbits & 0x1f)) - 1U & nHold) * 4);
          if (nBits < (pHere >> 8 & 0xff)) {
            do {
              if (nAvailIn == 0) goto LAB_0042afba;
              eState = *pNextInCur;
              nAvailIn = nAvailIn - 1;
              byShift = (byte)nBits;
              pNextInCur = (uint *)((int)pNextInCur + 1);
              nBits = nBits + 8;
              nHold = nHold + ((uint)(byte)eState << (byShift & 0x1f));
              pHere = *(uint *)((int)pState->lencode +
                               ((1 << ((byte)pState->lenbits & 0x1f)) - 1U & nHold) * 4);
              pNextIn = pNextInCur;
            } while (nBits < (pHere >> 8 & 0xff));
          }
          nLenVal = (ushort)(pHere >> 0x10);
          byShift = (byte)(pHere >> 8);
          if (nLenVal < 0x10) {
            eState = pHere >> 8;
            pHere = nHold >> (byShift & 0x1f);
            nBits = nBits - (eState & 0xff);
            pState->lens[pState->have] = nLenVal;
            pState->have = pState->have + 1;
          }
          else {
            if (nLenVal == 0x10) {
              if (nBits < (pHere >> 8 & 0xff) + 2) {
                do {
                  if (nAvailIn == 0) goto LAB_0042afba;
                  eState = *pNextInCur;
                  nAvailIn = nAvailIn - 1;
                  byShift3 = (byte)nBits;
                  pNextInCur = (uint *)((int)pNextInCur + 1);
                  nBits = nBits + 8;
                  nHold = nHold + ((uint)(byte)eState << (byShift3 & 0x1f));
                  pNextIn = pNextInCur;
                } while (nBits < (pHere >> 8 & 0xff) + 2);
              }
              nHold = nHold >> (byShift & 0x1f);
              nBits = nBits - (pHere >> 8 & 0xff);
              if (pState->have == 0) {
                pStrm->msg = "invalid bit length repeat";
                pHere = nHold;
                goto LAB_0042af57;
              }
              nLenVal = pState->lens[pState->have - 1];
              nCopy = (nHold & 3) + 3;
              pHere = nHold >> 2;
              nBits = nBits - 2;
            }
            else {
              eState = pHere >> 8 & 0xff;
              if (nLenVal == 0x11) {
                if (nBits < eState + 3) {
                  do {
                    if (nAvailIn == 0) goto LAB_0042afba;
                    nScratch = *pNextInCur;
                    nAvailIn = nAvailIn - 1;
                    byShift3 = (byte)nBits;
                    pNextInCur = (uint *)((int)pNextInCur + 1);
                    nBits = nBits + 8;
                    nHold = nHold + ((uint)(byte)nScratch << (byShift3 & 0x1f));
                    pNextIn = pNextInCur;
                  } while (nBits < eState + 3);
                }
                pHere = nHold >> (byShift & 0x1f);
                nCopy = (pHere & 7) + 3;
                pHere = pHere >> 3;
                pNextInTmp = -3;
              }
              else {
                if (nBits < eState + 7) {
                  do {
                    if (nAvailIn == 0) goto LAB_0042afba;
                    nScratch = *pNextInCur;
                    nAvailIn = nAvailIn - 1;
                    byShift3 = (byte)nBits;
                    pNextInCur = (uint *)((int)pNextInCur + 1);
                    nBits = nBits + 8;
                    nHold = nHold + ((uint)(byte)nScratch << (byShift3 & 0x1f));
                    pNextIn = pNextInCur;
                  } while (nBits < eState + 7);
                }
                pHere = nHold >> (byShift & 0x1f);
                nCopy = (pHere & 0x7f) + 0xb;
                pHere = pHere >> 7;
                pNextInTmp = -7;
              }
              nBits = nBits + (pNextInTmp - eState);
              nLenVal = 0;
            }
            if (pState->ndist + pState->nlen < pState->have + nCopy) {
              pStrm->msg = "invalid bit length repeat";
              nHold = pHere;
              goto LAB_0042af57;
            }
            for (; nCopy != 0; nCopy = nCopy - 1) {
              pState->lens[pState->have] = nLenVal;
              pState->have = pState->have + 1;
            }
          }
          nHold = pHere;
        } while (pState->have < pState->ndist + pState->nlen);
      }
      if (pState->mode != 0x1d) {
        if (pState->lens[0x100] == 0) {
          pStrm->msg = "invalid code -- missing end-of-block";
        }
        else {
          pState->next = pState + 1;
          pState->lencode = pState + 1;
          pState->lenbits = 9;
          nRet = D2Client::Source::SSComp::ZLIB_InflateTable
                           (1,(int32_t)pState->lens,pState->nlen,(int *)&pState->next,
                            &pState->lenbits,pState->work);
          if (nRet == 0) {
            pState->distcode = pState->next;
            pState->distbits = 6;
            nRet = D2Client::Source::SSComp::ZLIB_InflateTable
                             (2,(int32_t)(pState->lens + pState->nlen),pState->ndist,
                              (int *)&pState->next,&pState->distbits,pState->work);
            if (nRet == 0) {
              pState->mode = 0x13;
              pNextInCur = pNextIn;
              if (nFlush != 6) goto switchD_00429c46_caseD_42a918;
              goto LAB_0042afba;
            }
            pStrm->msg = "invalid distances set";
          }
          else {
            pStrm->msg = "invalid literal/lengths set";
          }
        }
        goto LAB_0042af57;
      }
      break;
    case 0x13:
switchD_00429c46_caseD_42a918:
      pState->mode = 0x14;
    case 0x14:
      if ((5 < nAvailIn) && (0x101 < nAvailOut)) {
        pStrm->avail_out = nAvailOut;
        pStrm->next_out = pNextOut;
        pStrm->avail_in = nAvailIn;
        pStrm->next_in = (byte *)pNextIn;
        pState->hold = nHold;
        pState->bits = nBits;
        D2Client::Source::SSComp::ZLIB_InflateFast(&pStrm->next_in,nAvailOutStart);
        pNextOut = pStrm->next_out;
        nAvailOut = pStrm->avail_out;
        nHold = pState->hold;
        nBits = pState->bits;
        pNextIn = (uint *)pStrm->next_in;
        nAvailIn = pStrm->avail_in;
        pHere = nHold;
        if (pState->mode == 0xb) {
          pState[5].lens[0xb2] = 0xffff;
          pState[5].lens[0xb3] = 0xffff;
        }
        break;
      }
      pInTmp = pState->lenbits;
      pvVar1 = pState->lencode;
      pState[5].lens[0xb2] = 0;
      pState[5].lens[0xb3] = 0;
      eState = *(uint *)((int)pvVar1 + ((1 << ((byte)pInTmp & 0x1f)) - 1U & nHold) * 4);
      pHere = eState;
      if (nBits < (eState >> 8 & 0xff)) {
        do {
          pNextInCur = pNextIn;
          if (nAvailIn == 0) goto LAB_0042afba;
          eState = *pNextIn;
          nAvailIn = nAvailIn - 1;
          byShift = (byte)nBits;
          pNextIn = (uint *)((int)pNextIn + 1);
          nBits = nBits + 8;
          nHold = nHold + ((uint)(byte)eState << (byShift & 0x1f));
          eState = *(uint *)((int)pState->lencode +
                            ((1 << ((byte)pState->lenbits & 0x1f)) - 1U & nHold) * 4);
          pHere = eState;
        } while (nBits < (eState >> 8 & 0xff));
      }
      byOp = (char)eState;
      pHere = eState;
      if ((byOp != '\0') && ((eState & 0xf0) == 0)) {
        byShift = (byte)(eState >> 8);
        pHere = *(uint *)((int)pState->lencode +
                         ((((1 << (byOp + byShift & 0x1f)) - 1U & nHold) >> (byShift & 0x1f)) +
                         (eState >> 0x10)) * 4);
        nCopy = eState;
        if (nBits < (pHere >> 8 & 0xff) + (eState >> 8 & 0xff)) {
          do {
            pNextInCur = pNextIn;
            if (nAvailIn == 0) goto LAB_0042afba;
            nScratch = *pNextIn;
            nAvailIn = nAvailIn - 1;
            pNextIn = (uint *)((int)pNextIn + 1);
            nHold = nHold + ((uint)(byte)nScratch << ((byte)nBits & 0x1f));
            nBits = nBits + 8;
            pHere = *(uint *)((int)pState->lencode +
                             ((((1 << (byOp + byShift & 0x1f)) - 1U & nHold) >> (byShift & 0x1f)) +
                             (eState >> 0x10)) * 4);
          } while (nBits < (pHere >> 8 & 0xff) + (eState >> 8 & 0xff));
        }
        nHold = nHold >> (byShift & 0x1f);
        nBits = nBits - byShift;
        *(uint *)(pState[5].lens + 0xb2) = (uint)byShift;
      }
      eState = pHere >> 8 & 0xff;
      *(uint *)(pState[5].lens + 0xb2) = *(int *)(pState[5].lens + 0xb2) + eState;
      nHold = nHold >> ((byte)(pHere >> 8) & 0x1f);
      nBits = nBits - eState;
      pState->length = pHere >> 0x10;
      if ((char)pHere == '\0') {
        pState->mode = 0x19;
        pHere = nHold;
        break;
      }
      if ((pHere & 0x20) != 0) {
        pState[5].lens[0xb2] = 0xffff;
        pState[5].lens[0xb3] = 0xffff;
        pState->mode = 0xb;
        pHere = nHold;
        break;
      }
      if ((pHere & 0x40) != 0) {
        pStrm->msg = "invalid literal/length code";
        pHere = nHold;
        goto LAB_0042af57;
      }
      pState->extra = pHere & 0xf;
      pState->mode = 0x15;
      pHere = nHold;
switchD_00429c46_caseD_42ab32:
      if (pState->extra != 0) {
        if (nBits < pState->extra) {
          do {
            pNextInCur = pNextIn;
            if (nAvailIn == 0) goto LAB_0042afba;
            eState = *pNextIn;
            nAvailIn = nAvailIn - 1;
            byShift = (byte)nBits;
            pNextIn = (uint *)((int)pNextIn + 1);
            nBits = nBits + 8;
            nHold = nHold + ((uint)(byte)eState << (byShift & 0x1f));
          } while (nBits < pState->extra);
        }
        pInTmp = pState->extra;
        nBits = nBits - pInTmp;
        pState->length = pState->length + ((1 << ((byte)pInTmp & 0x1f)) - 1U & nHold);
        nHold = nHold >> ((byte)pInTmp & 0x1f);
        *(uint32_t *)(pState[5].lens + 0xb2) = *(int *)(pState[5].lens + 0xb2) + pInTmp;
      }
      *(uint32_t *)(pState[5].lens + 0xb4) = pState->length;
      pState->mode = 0x16;
switchD_00429c46_caseD_42ab90:
      eState = *(uint *)((int)pState->distcode +
                        ((1 << ((byte)pState->distbits & 0x1f)) - 1U & nHold) * 4);
      pHere = eState;
      if (nBits < (eState >> 8 & 0xff)) {
        do {
          pNextInCur = pNextIn;
          if (nAvailIn == 0) goto LAB_0042afba;
          eState = *pNextIn;
          nAvailIn = nAvailIn - 1;
          byShift = (byte)nBits;
          pNextIn = (uint *)((int)pNextIn + 1);
          nBits = nBits + 8;
          nHold = nHold + ((uint)(byte)eState << (byShift & 0x1f));
          eState = *(uint *)((int)pState->distcode +
                            ((1 << ((byte)pState->distbits & 0x1f)) - 1U & nHold) * 4);
          pHere = eState;
        } while (nBits < (eState >> 8 & 0xff));
      }
      pHere = eState;
      if ((eState & 0xf0) == 0) {
        byShift = (byte)(eState >> 8);
        pHere = *(uint *)((int)pState->distcode +
                         ((((1 << ((char)eState + byShift & 0x1f)) - 1U & nHold) >> (byShift & 0x1f)
                          ) + (eState >> 0x10)) * 4);
        nCopy = eState;
        if (nBits < (pHere >> 8 & 0xff) + (eState >> 8 & 0xff)) {
          do {
            pNextInCur = pNextIn;
            if (nAvailIn == 0) goto LAB_0042afba;
            nScratch = *pNextIn;
            nAvailIn = nAvailIn - 1;
            pNextIn = (uint *)((int)pNextIn + 1);
            nHold = nHold + ((uint)(byte)nScratch << ((byte)nBits & 0x1f));
            nBits = nBits + 8;
            pHere = *(uint *)((int)pState->distcode +
                             ((((1 << ((char)eState + byShift & 0x1f)) - 1U & nHold) >>
                              (byShift & 0x1f)) + (eState >> 0x10)) * 4);
          } while (nBits < (pHere >> 8 & 0xff) + (eState >> 8 & 0xff));
        }
        nHold = nHold >> (byShift & 0x1f);
        nBits = nBits - byShift;
        *(uint *)(pState[5].lens + 0xb2) = *(int *)(pState[5].lens + 0xb2) + (uint)byShift;
      }
      eState = pHere >> 8 & 0xff;
      *(uint *)(pState[5].lens + 0xb2) = *(int *)(pState[5].lens + 0xb2) + eState;
      nHold = nHold >> ((byte)(pHere >> 8) & 0x1f);
      nBits = nBits - eState;
      if ((pHere & 0x40) != 0) {
        pStrm->msg = "invalid distance code";
        pHere = nHold;
        goto LAB_0042af57;
      }
      pState->extra = pHere & 0xf;
      pState->offset_val = pHere >> 0x10;
      pState->mode = 0x17;
      pHere = nHold;
switchD_00429c46_caseD_42acfc:
      if (pState->extra != 0) {
        if (nBits < pState->extra) {
          do {
            pNextInCur = pNextIn;
            if (nAvailIn == 0) goto LAB_0042afba;
            eState = *pNextIn;
            nAvailIn = nAvailIn - 1;
            byShift = (byte)nBits;
            pNextIn = (uint *)((int)pNextIn + 1);
            nBits = nBits + 8;
            nHold = nHold + ((uint)(byte)eState << (byShift & 0x1f));
          } while (nBits < pState->extra);
        }
        pInTmp = pState->extra;
        nBits = nBits - pInTmp;
        pState->offset_val = pState->offset_val + ((1 << ((byte)pInTmp & 0x1f)) - 1U & nHold);
        nHold = nHold >> ((byte)pInTmp & 0x1f);
        *(uint32_t *)(pState[5].lens + 0xb2) = *(int *)(pState[5].lens + 0xb2) + pInTmp;
        pHere = nHold;
      }
      pState->mode = 0x18;
switchD_00429c46_caseD_42ad5d:
      pNextInCur = pNextIn;
      if (nAvailOut != 0) {
        eState = pState->offset_val;
        if (nAvailOutStart - nAvailOut < eState) {
          nCopy = eState - (nAvailOutStart - nAvailOut);
          if ((pState->whave < nCopy) && (*(int *)(pState[5].lens + 0xb0) != 0)) {
            pStrm->msg = "invalid distance too far back";
            goto LAB_0042af57;
          }
          eState = pState->wnext;
          if (eState < nCopy) {
            nCopy = nCopy - eState;
            pNextInTmp = pState->wsize - nCopy;
          }
          else {
            pNextInTmp = eState - nCopy;
          }
          pFrom = pState->window + pNextInTmp;
          nFrom = pState->length;
          if (nFrom < nCopy) {
            nCopy = nFrom;
          }
        }
        else {
          pFrom = pNextOut + -eState;
          nFrom = pState->length;
          nCopy = nFrom;
        }
        if (nAvailOut < nCopy) {
          nCopy = nAvailOut;
        }
        nAvailOut = nAvailOut - nCopy;
        pState->length = nFrom - nCopy;
        do {
          *pNextOut = *pFrom;
          pNextOut = pNextOut + 1;
          pFrom = pFrom + 1;
          nCopy = nCopy - 1;
        } while (nCopy != 0);
        nCopy = 0;
        if (pState->length == 0) {
          pState->mode = 0x14;
        }
        break;
      }
      goto LAB_0042afba;
    case 0x15:
      goto switchD_00429c46_caseD_42ab32;
    case 0x16:
      goto switchD_00429c46_caseD_42ab90;
    case 0x17:
      goto switchD_00429c46_caseD_42acfc;
    case 0x18:
      goto switchD_00429c46_caseD_42ad5d;
    case 0x19:
      if (nAvailOut == 0) goto LAB_0042afba;
      *pNextOut = (byte)pState->length;
      pNextOut = pNextOut + 1;
      nAvailOut = nAvailOut - 1;
      pState->mode = 0x14;
      break;
    case 0x1a:
      if (pState->wrap != 0) {
        for (; nBits < 0x20; nBits = nBits + 8) {
          pNextInCur = pNextIn;
          if (nAvailIn == 0) goto LAB_0042afba;
          eState = *pNextIn;
          nAvailIn = nAvailIn - 1;
          pNextIn = (uint *)((int)pNextIn + 1);
          nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
          pHere = nHold;
        }
        nAvailOutStart = nAvailOutStart - nAvailOut;
        pStrm->total_out = pStrm->total_out + nAvailOutStart;
        pState->total = pState->total + nAvailOutStart;
        if (nAvailOutStart != 0) {
          if (pState->flags == 0) {
            pInTmp = D2Client::Source::SSComp::ZLIB_Adler32
                               (pState->check,pNextOut + -nAvailOutStart,nAvailOutStart);
          }
          else {
            pInTmp = Storm::_3rdparty::zlib::crc32::crc32
                               (pState->check,(uint *)(pNextOut + -nAvailOutStart),nAvailOutStart);
          }
          pState->check = pInTmp;
          pStrm->adler = pInTmp;
        }
        nAvailOutStart = nAvailOut;
        eState = nHold;
        if (pState->flags == 0) {
          eState = ((nHold & 0xff00) + nHold * 0x10000) * 0x100 + (pHere >> 0x10 & 0xff) * 0x100 +
                   (nHold >> 0x18);
        }
        if (eState != pState->check) {
          pStrm->msg = "incorrect data check";
          goto LAB_0042af57;
        }
        nHold = 0;
        pHere = 0;
        nBits = 0;
      }
      pState->mode = 0x1b;
    case 0x1b:
      if ((pState->wrap != 0) && (pState->flags != 0)) {
        for (; nBits < 0x20; nBits = nBits + 8) {
          pNextInCur = pNextIn;
          if (nAvailIn == 0) goto LAB_0042afba;
          eState = *pNextIn;
          nAvailIn = nAvailIn - 1;
          pNextIn = (uint *)((int)pNextIn + 1);
          nHold = nHold + ((uint)(byte)eState << ((byte)nBits & 0x1f));
          pHere = nHold;
        }
        if (nHold != pState->total) {
          pStrm->msg = "incorrect length check";
          goto LAB_0042af57;
        }
        nHold = 0;
        nBits = 0;
      }
      pState->mode = 0x1c;
switchD_00429c46_caseD_42afaa:
      nRet = 1;
      pNextInCur = pNextIn;
      goto LAB_0042afba;
    case 0x1c:
      goto switchD_00429c46_caseD_42afaa;
    case 0x1d:
      nRet = -3;
      goto LAB_0042afba;
    case 0x1e:
      goto switchD_00429c46_caseD_42b013;
    }
LAB_0042af5d:
    eState = pState->mode;
    if (0x1e < eState) {
      return -2;
    }
  } while( true );
}


