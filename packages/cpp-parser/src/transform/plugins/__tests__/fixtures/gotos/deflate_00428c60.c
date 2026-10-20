
/* @function ZLIB_Deflate
   @address Game.exe.ram:00428c60
   @date 2026.06.12
   @calling __fastcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

uint32_t __fastcall Storm::_3rdparty::zlib::deflate::deflate(z_stream *pStream,int *nFlush)

{
  deflate_state *pDeflateState;
  byte byOsFlags;
  char byHeaderByte;
  uint32_t nChecksum;
  int nLevelFlag;
  z_stream *pStateForPutShort1;
  z_stream *pStateForPutShort2;
  undefined3 byHuffHi;
  undefined3 byRleHi;
  int nBlockState;
  z_stream *pStateForPutShort3;
  uint nHeader;
  uint nCrcPendingStart;
  deflate_state *pState;
  bool bDone;
  int *pGzHeader;
  
  if (((pStream == (z_stream *)0x0) ||
      (pDeflateState = pStream->state, pDeflateState == (deflate_state *)0x0)) ||
     ((int *)0x5 < nFlush)) {
    return 0xfffffffe;
  }
  if (((pStream->next_out == (byte *)0x0) ||
      ((pStream->next_in == (byte *)0x0 && (pStream->avail_in != 0)))) ||
     ((pDeflateState->status == 0x29a && (nFlush != (int *)&DAT_00000004)))) {
    pStream->msg = "stream error";
    return 0xfffffffe;
  }
  if (pStream->avail_out == 0) {
    pStream->msg = "buffer error";
    return 0xfffffffb;
  }
  nBlockState = pDeflateState->last_flush;
  pDeflateState->strm = pStream;
  pDeflateState->last_flush = (int32_t)nFlush;
  if (pDeflateState->status == 0x2a) {
    if (pDeflateState->wrap == 2) {
      nChecksum = Storm::_3rdparty::zlib::crc32::crc32(0,(uint *)0x0,0);
      pStream->adler = nChecksum;
      pDeflateState->pending_buf[pDeflateState->pending] = 0x1f;
      pDeflateState->pending = pDeflateState->pending + 1;
      pDeflateState->pending_buf[pDeflateState->pending] = 0x8b;
      pDeflateState->pending = pDeflateState->pending + 1;
      pDeflateState->pending_buf[pDeflateState->pending] = 8;
      pDeflateState->pending = pDeflateState->pending + 1;
      pGzHeader = pDeflateState->gzhead;
      if (pGzHeader == (int *)0x0) {
        pDeflateState->pending_buf[pDeflateState->pending] = 0;
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] = 0;
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] = 0;
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] = 0;
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] = 0;
        pDeflateState->pending = pDeflateState->pending + 1;
        if (pDeflateState->level == 9) {
          byOsFlags = 2;
        }
        else if ((pDeflateState->strategy < 2) && (1 < pDeflateState->level)) {
          byOsFlags = 0;
        }
        else {
          byOsFlags = 4;
        }
        pDeflateState->pending_buf[pDeflateState->pending] = byOsFlags;
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] = 0xb;
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->status = 0x71;
      }
      else {
        pDeflateState->pending_buf[pDeflateState->pending] =
             (-(pGzHeader[9] != 0) & 0x10U) + (-(pGzHeader[0xb] != 0) & 2U) +
             (-(pGzHeader[7] != 0) & 8U) + (-(pGzHeader[4] != 0) & 4U) + (*pGzHeader != 0);
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] =
             *(byte *)((int)pDeflateState->gzhead + 4);
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] =
             *(byte *)((int)pDeflateState->gzhead + 5);
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] =
             *(byte *)((int)pDeflateState->gzhead + 6);
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] =
             *(byte *)((int)pDeflateState->gzhead + 7);
        pDeflateState->pending = pDeflateState->pending + 1;
        if (pDeflateState->level == 9) {
          byOsFlags = 2;
        }
        else if ((pDeflateState->strategy < 2) && (1 < pDeflateState->level)) {
          byOsFlags = 0;
        }
        else {
          byOsFlags = 4;
        }
        pDeflateState->pending_buf[pDeflateState->pending] = byOsFlags;
        pDeflateState->pending = pDeflateState->pending + 1;
        pDeflateState->pending_buf[pDeflateState->pending] =
             *(byte *)((int)pDeflateState->gzhead + 0xc);
        pDeflateState->pending = pDeflateState->pending + 1;
        nChecksum = pDeflateState->pending;
        if (*(int *)((int)pDeflateState->gzhead + 0x10) != 0) {
          pDeflateState->pending_buf[nChecksum] = *(byte *)((int)pDeflateState->gzhead + 0x14);
          pDeflateState->pending = pDeflateState->pending + 1;
          pDeflateState->pending_buf[pDeflateState->pending] =
               *(byte *)((int)pDeflateState->gzhead + 0x15);
          pDeflateState->pending = pDeflateState->pending + 1;
          nChecksum = pDeflateState->pending;
        }
        if (*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) {
          nChecksum = Storm::_3rdparty::zlib::crc32::crc32
                                (pStream->adler,(uint *)pDeflateState->pending_buf,nChecksum);
          pStream->adler = nChecksum;
        }
        pDeflateState->gzindex = 0;
        pDeflateState->status = 0x45;
      }
    }
    else {
      if ((pDeflateState->strategy < 2) && (nLevelFlag = pDeflateState->level, 1 < nLevelFlag)) {
        if (nLevelFlag < 6) {
          nLevelFlag = 1;
        }
        else {
          nLevelFlag = (nLevelFlag != 6) + 2;
        }
      }
      else {
        nLevelFlag = 0;
      }
      nHeader = (pDeflateState->w_bits - 8) * 0x1000 + 0x800 | nLevelFlag << 6;
      if (pDeflateState->strstart != 0) {
        nHeader = nHeader | 0x20;
      }
      pDeflateState->status = 0x71;
      Storm::_3rdparty::zlib::deflate::putShortMSB
                ((nHeader / 0x1f + 1) * 0x1f,(z_stream *)pDeflateState);
      if (pDeflateState->strstart != 0) {
        Storm::_3rdparty::zlib::deflate::putShortMSB
                  ((uint)*(ushort *)((int)&pStream->adler + 2),pStateForPutShort1);
        Storm::_3rdparty::zlib::deflate::putShortMSB
                  ((uint)(ushort)pStream->adler,pStateForPutShort2);
      }
      nChecksum = D2Client::Source::SSComp::ZLIB_Adler32(0,(byte *)0x0,0);
      pStream->adler = nChecksum;
    }
  }
  if (pDeflateState->status == 0x45) {
    if (*(int *)((int)pDeflateState->gzhead + 0x10) != 0) {
      nCrcPendingStart = pDeflateState->pending;
      if ((uint)pDeflateState->gzindex < (uint)*(ushort *)((int)pDeflateState->gzhead + 0x14)) {
        do {
          nHeader = pDeflateState->pending;
          if (nHeader == pDeflateState->pending_buf_size) {
            if ((*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) && (nCrcPendingStart < nHeader))
            {
              nChecksum = Storm::_3rdparty::zlib::crc32::crc32
                                    (pStream->adler,
                                     (uint *)(pDeflateState->pending_buf + nCrcPendingStart),
                                     nHeader - nCrcPendingStart);
              pStream->adler = nChecksum;
            }
            Storm::_3rdparty::zlib::deflate::flush_pending(pStream);
            nHeader = pDeflateState->pending;
            nCrcPendingStart = nHeader;
            if (nHeader == pDeflateState->pending_buf_size) break;
          }
          pDeflateState->pending_buf[nHeader] =
               *(byte *)(*(int *)((int)pDeflateState->gzhead + 0x10) + pDeflateState->gzindex);
          pDeflateState->pending = pDeflateState->pending + 1;
          pDeflateState->gzindex = pDeflateState->gzindex + 1;
        } while ((uint)pDeflateState->gzindex < (uint)*(ushort *)((int)pDeflateState->gzhead + 0x14)
                );
      }
      if ((*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) &&
         (nCrcPendingStart < pDeflateState->pending)) {
        nChecksum = Storm::_3rdparty::zlib::crc32::crc32
                              (pStream->adler,
                               (uint *)(pDeflateState->pending_buf + nCrcPendingStart),
                               pDeflateState->pending - nCrcPendingStart);
        pStream->adler = nChecksum;
      }
      if (pDeflateState->gzindex != *(int *)((int)pDeflateState->gzhead + 0x14)) goto LAB_00429052;
      pDeflateState->gzindex = 0;
    }
    pDeflateState->status = 0x49;
  }
LAB_00429052:
  if (pDeflateState->status == 0x49) {
    if (*(int *)((int)pDeflateState->gzhead + 0x1c) != 0) {
      nCrcPendingStart = pDeflateState->pending;
      do {
        nHeader = pDeflateState->pending;
        if (nHeader == pDeflateState->pending_buf_size) {
          if ((*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) && (nCrcPendingStart < nHeader)) {
            nChecksum = Storm::_3rdparty::zlib::crc32::crc32
                                  (pStream->adler,
                                   (uint *)(pDeflateState->pending_buf + nCrcPendingStart),
                                   nHeader - nCrcPendingStart);
            pStream->adler = nChecksum;
          }
          Storm::_3rdparty::zlib::deflate::flush_pending(pStream);
          nHeader = pDeflateState->pending;
          nCrcPendingStart = nHeader;
          if (nHeader == pDeflateState->pending_buf_size) {
            bDone = true;
            break;
          }
        }
        byOsFlags = *(byte *)(*(int *)((int)pDeflateState->gzhead + 0x1c) + pDeflateState->gzindex);
        pDeflateState->gzindex = pDeflateState->gzindex + 1;
        pDeflateState->pending_buf[nHeader] = byOsFlags;
        pDeflateState->pending = pDeflateState->pending + 1;
        bDone = false;
      } while (byOsFlags != 0);
      if ((*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) &&
         (nCrcPendingStart < pDeflateState->pending)) {
        nChecksum = Storm::_3rdparty::zlib::crc32::crc32
                              (pStream->adler,
                               (uint *)(pDeflateState->pending_buf + nCrcPendingStart),
                               pDeflateState->pending - nCrcPendingStart);
        pStream->adler = nChecksum;
      }
      if (bDone) goto LAB_00429108;
      pDeflateState->gzindex = 0;
    }
    pDeflateState->status = 0x5b;
  }
LAB_00429108:
  if (pDeflateState->status == 0x5b) {
    if (*(int *)((int)pDeflateState->gzhead + 0x24) != 0) {
      nCrcPendingStart = pDeflateState->pending;
      do {
        nHeader = pDeflateState->pending;
        if (nHeader == pDeflateState->pending_buf_size) {
          if ((*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) && (nCrcPendingStart < nHeader)) {
            nChecksum = Storm::_3rdparty::zlib::crc32::crc32
                                  (pStream->adler,
                                   (uint *)(pDeflateState->pending_buf + nCrcPendingStart),
                                   nHeader - nCrcPendingStart);
            pStream->adler = nChecksum;
          }
          Storm::_3rdparty::zlib::deflate::flush_pending(pStream);
          nHeader = pDeflateState->pending;
          nCrcPendingStart = nHeader;
          if (nHeader == pDeflateState->pending_buf_size) {
            bDone = true;
            break;
          }
        }
        byOsFlags = *(byte *)(*(int *)((int)pDeflateState->gzhead + 0x24) + pDeflateState->gzindex);
        pDeflateState->gzindex = pDeflateState->gzindex + 1;
        pDeflateState->pending_buf[nHeader] = byOsFlags;
        pDeflateState->pending = pDeflateState->pending + 1;
        bDone = false;
      } while (byOsFlags != 0);
      if ((*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) &&
         (nCrcPendingStart < pDeflateState->pending)) {
        nChecksum = Storm::_3rdparty::zlib::crc32::crc32
                              (pStream->adler,
                               (uint *)(pDeflateState->pending_buf + nCrcPendingStart),
                               pDeflateState->pending - nCrcPendingStart);
        pStream->adler = nChecksum;
      }
      if (bDone) goto LAB_004291ba;
    }
    pDeflateState->status = 0x67;
  }
LAB_004291ba:
  if (pDeflateState->status == 0x67) {
    if (*(int *)((int)pDeflateState->gzhead + 0x2c) != 0) {
      if (pDeflateState->pending_buf_size < pDeflateState->pending + 2) {
        Storm::_3rdparty::zlib::deflate::flush_pending(pStream);
      }
      if (pDeflateState->pending_buf_size < pDeflateState->pending + 2) goto LAB_00429219;
      pDeflateState->pending_buf[pDeflateState->pending] = (byte)pStream->adler;
      pDeflateState->pending = pDeflateState->pending + 1;
      pDeflateState->pending_buf[pDeflateState->pending] = *(byte *)((int)&pStream->adler + 1);
      pDeflateState->pending = pDeflateState->pending + 1;
      nChecksum = Storm::_3rdparty::zlib::crc32::crc32(0,(uint *)0x0,0);
      pStream->adler = nChecksum;
    }
    pDeflateState->status = 0x71;
  }
LAB_00429219:
  if (pDeflateState->pending == 0) {
    if (((pStream->avail_in == 0) &&
        ((int)((int)nFlush * 2 - (((int)nFlush < 5) - 1 & 9)) <=
         (int)(nBlockState * 2 - ((nBlockState < 5) - 1 & 9)))) && (nFlush != (int *)&DAT_00000004))
    {
      pStream->msg = "buffer error";
      return 0xfffffffb;
    }
  }
  else {
    Storm::_3rdparty::zlib::deflate::flush_pending(pStream);
    if (pStream->avail_out == 0) {
      pDeflateState->last_flush = -1;
      return 0;
    }
  }
  if (pDeflateState->status == 0x29a) {
    if (pStream->avail_in != 0) {
      pStream->msg = "buffer error";
      return 0xfffffffb;
    }
LAB_004292b9:
    if ((pDeflateState->lookahead == 0) &&
       ((nFlush == (int *)0x0 || (pDeflateState->status == 0x29a)))) goto LAB_004293b8;
  }
  else if (pStream->avail_in == 0) goto LAB_004292b9;
  if (pDeflateState->strategy == 2) {
    byHeaderByte = Storm::_3rdparty::zlib::deflate::deflate_huff((int32_t)nFlush,pDeflateState);
    nBlockState = CONCAT31(byHuffHi,byHeaderByte);
  }
  else if (pDeflateState->strategy == 3) {
    byHeaderByte = Storm::_3rdparty::zlib::deflate::deflate_rle((int32_t)nFlush,pDeflateState);
    nBlockState = CONCAT31(byRleHi,byHeaderByte);
  }
  else {
    nBlockState = (*gaSSCompDeflateBlockTable[pDeflateState->level].pfnDeflateBlock)
                            (pDeflateState,(int32_t)nFlush);
  }
  if ((nBlockState == 2) || (nBlockState == 3)) {
    pDeflateState->status = 0x29a;
  }
  if ((nBlockState == 0) || (nBlockState == 2)) {
    if (pStream->avail_out != 0) {
      return 0;
    }
    pDeflateState->last_flush = -1;
    return 0;
  }
  if (nBlockState == 1) {
    if (nFlush == (int *)0x1) {
      Storm::_3rdparty::zlib::trees::_tr_align((int32_t)pDeflateState);
    }
    else if ((nFlush != (int *)0x5) &&
            (Storm::_3rdparty::zlib::trees::_tr_stored_block
                       ((int32_t)pDeflateState,(undefined *)0x0,0,0), nFlush == (int *)0x3)) {
      pDeflateState->head[pDeflateState->hash_size - 1] = 0;
      compiler::memset(pDeflateState->head,0,pDeflateState->hash_size * 2 - 2);
      if (pDeflateState->lookahead == 0) {
        pDeflateState->strstart = 0;
        pDeflateState->block_start = 0;
        pDeflateState->matches = 0;
      }
    }
    Storm::_3rdparty::zlib::deflate::flush_pending(pStream);
    if (pStream->avail_out == 0) {
      pDeflateState->last_flush = -1;
      return 0;
    }
  }
LAB_004293b8:
  if (nFlush != (int *)&DAT_00000004) {
    return 0;
  }
  if (pDeflateState->wrap < 1) {
    return 1;
  }
  if (pDeflateState->wrap == 2) {
    pDeflateState->pending_buf[pDeflateState->pending] = (byte)pStream->adler;
    pDeflateState->pending = pDeflateState->pending + 1;
    pDeflateState->pending_buf[pDeflateState->pending] = *(byte *)((int)&pStream->adler + 1);
    pDeflateState->pending = pDeflateState->pending + 1;
    pDeflateState->pending_buf[pDeflateState->pending] = *(byte *)((int)&pStream->adler + 2);
    pDeflateState->pending = pDeflateState->pending + 1;
    pDeflateState->pending_buf[pDeflateState->pending] = *(byte *)((int)&pStream->adler + 3);
    pDeflateState->pending = pDeflateState->pending + 1;
    pDeflateState->pending_buf[pDeflateState->pending] = (byte)pStream->total_in;
    pDeflateState->pending = pDeflateState->pending + 1;
    pDeflateState->pending_buf[pDeflateState->pending] = *(byte *)((int)&pStream->total_in + 1);
    pDeflateState->pending = pDeflateState->pending + 1;
    pDeflateState->pending_buf[pDeflateState->pending] = *(byte *)((int)&pStream->total_in + 2);
    pDeflateState->pending = pDeflateState->pending + 1;
    pDeflateState->pending_buf[pDeflateState->pending] = *(byte *)((int)&pStream->total_in + 3);
    pDeflateState->pending = pDeflateState->pending + 1;
  }
  else {
    Storm::_3rdparty::zlib::deflate::putShortMSB
              ((uint)*(ushort *)((int)&pStream->adler + 2),(z_stream *)pDeflateState);
    Storm::_3rdparty::zlib::deflate::putShortMSB((uint)(ushort)pStream->adler,pStateForPutShort3);
  }
  Storm::_3rdparty::zlib::deflate::flush_pending(pStream);
  if (0 < pDeflateState->wrap) {
    pDeflateState->wrap = -pDeflateState->wrap;
  }
  return (uint)(pDeflateState->pending == 0);
}


