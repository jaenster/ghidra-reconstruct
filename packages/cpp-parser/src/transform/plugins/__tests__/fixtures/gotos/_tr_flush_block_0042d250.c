
/* @function ZLIB_FlushBlock
   @address Game.exe.ram:0042d250
   @date 2026.06.06
   @calling __fastcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

void __fastcall
Storm::_3rdparty::zlib::trees::_tr_flush_block
          (int *pnState,undefined *pbBuf,int32_t nStoredLen,int32_t nLast)

{
  BOOL nInitBlockArg;
  int nBlTreeMaxCode;
  uint nStaticLen;
  undefined4 nInitArgStored;
  undefined4 nInitArgCompressed;
  undefined4 nUnused;
  uint nOptLen;
  int nMaxBlIndex;
  int nBitCount;
  int nState;
  int *pnDTree;
  int *pnLTree;
  
  nMaxBlIndex = 0;
  if (pnState[0x21] < 1) {
    nStaticLen = nStoredLen + 5;
  }
  else {
    nState = *pnState;
    if (*(int *)(nState + 0x2c) == 2) {
      nInitBlockArg = Storm::_3rdparty::zlib::trees::detect_data_type((int32_t)pnState);
      *(BOOL *)(nState + 0x2c) = nInitBlockArg;
    }
    Storm::_3rdparty::zlib::trees::build_tree(pnState + 0x2c6,(int32_t)pnState);
    Storm::_3rdparty::zlib::trees::build_tree(pnState + 0x2c9,(int32_t)pnState);
    Storm::_3rdparty::zlib::trees::build_bl_tree((int32_t)pnState);
    nOptLen = pnState[0x5aa] + 10U >> 3;
    nStaticLen = pnState[0x5ab] + 10U >> 3;
    nMaxBlIndex = nBlTreeMaxCode;
    if (nOptLen < nStaticLen) goto LAB_0042d2c3;
  }
  nOptLen = nStaticLen;
LAB_0042d2c3:
  if ((nOptLen < nStoredLen + 4U) || (pbBuf == (undefined *)0x0)) {
    if ((pnState[0x22] == 4) || (nStaticLen == nOptLen)) {
      nBitCount = pnState[0x5af];
      nState = nLast + 2;
      if (nBitCount < 0xe) {
        *(ushort *)(pnState + 0x5ae) =
             *(ushort *)(pnState + 0x5ae) | (ushort)(nState << ((byte)nBitCount & 0x1f));
        pnState[0x5af] = nBitCount + 3;
      }
      else {
        *(ushort *)(pnState + 0x5ae) =
             *(ushort *)(pnState + 0x5ae) | (ushort)(nState << ((byte)nBitCount & 0x1f));
        *(char *)(pnState[5] + pnState[2]) = (char)pnState[0x5ae];
        pnState[5] = pnState[5] + 1;
        *(undefined1 *)(pnState[5] + pnState[2]) = *(undefined1 *)((int)pnState + 0x16b9);
        nBitCount = pnState[0x5af];
        pnState[5] = pnState[5] + 1;
        pnState[0x5af] = nBitCount + -0xd;
        *(ushort *)(pnState + 0x5ae) = (ushort)nState >> (0x10U - (char)nBitCount & 0x1f);
      }
      pnDTree = &gnSSCompPHDCompressedSize;
      pnLTree = &gnSSCompBLZCompressedSize;
    }
    else {
      nBitCount = pnState[0x5af];
      nState = nLast + 4;
      if (nBitCount < 0xe) {
        *(ushort *)(pnState + 0x5ae) =
             *(ushort *)(pnState + 0x5ae) | (ushort)(nState << ((byte)nBitCount & 0x1f));
        pnState[0x5af] = nBitCount + 3;
      }
      else {
        *(ushort *)(pnState + 0x5ae) =
             *(ushort *)(pnState + 0x5ae) | (ushort)(nState << ((byte)nBitCount & 0x1f));
        *(char *)(pnState[5] + pnState[2]) = (char)pnState[0x5ae];
        pnState[5] = pnState[5] + 1;
        *(undefined1 *)(pnState[5] + pnState[2]) = *(undefined1 *)((int)pnState + 0x16b9);
        nBitCount = pnState[0x5af];
        pnState[5] = pnState[5] + 1;
        pnState[0x5af] = nBitCount + -0xd;
        *(ushort *)(pnState + 0x5ae) = (ushort)nState >> (0x10U - (char)nBitCount & 0x1f);
      }
      Storm::_3rdparty::zlib::trees::send_all_trees
                (pnState[0x2c7] + 1,pnState[0x2ca] + 1,nMaxBlIndex + 1,(int32_t)pnState);
      pnDTree = pnState + 0x262;
      pnLTree = pnState + 0x25;
    }
    Storm::_3rdparty::zlib::trees::compress_block
              ((int32_t)pnLTree,(int32_t)pnDTree,(int32_t)pnState);
    nUnused = nInitArgCompressed;
  }
  else {
    Storm::_3rdparty::zlib::trees::_tr_stored_block((int32_t)pnState,pbBuf,nStoredLen,nLast);
    nUnused = nInitArgStored;
  }
  Storm::_3rdparty::zlib::trees::init_block(nUnused,(int32_t)pnState);
  if (nLast != 0) {
    Storm::_3rdparty::zlib::trees::bi_windup((int32_t)pnState);
  }
  return;
}


