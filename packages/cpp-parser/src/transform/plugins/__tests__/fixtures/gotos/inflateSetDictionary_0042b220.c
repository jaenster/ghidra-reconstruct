
/* @function ZLIB_InflateSyncPoint
   @address Game.exe.ram:0042b220
   @date 2026.06.12
   @calling __fastcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

undefined4 __fastcall
Storm::_3rdparty::zlib::inflate::inflateSetDictionary
          (z_stream *pStream,byte *pDictionary,uint32_t nDictLength)

{
  uint32_t nAdler;
  BOOL nWindowRet;
  inflate_state *pState;
  
  if ((pStream == (z_stream *)0x0) || (pState = pStream->state, pState == (inflate_state *)0x0)) {
    return 0xfffffffe;
  }
  if (pState->wrap == 0) {
    if (pState->mode != 10) goto LAB_0042b28d;
  }
  else if (pState->mode != 10) {
    return 0xfffffffe;
  }
  nAdler = D2Client::Source::SSComp::ZLIB_Adler32(0,(byte *)0x0,0);
  nAdler = D2Client::Source::SSComp::ZLIB_Adler32(nAdler,pDictionary,nDictLength);
  if (nAdler != pState->check) {
    return 0xfffffffd;
  }
LAB_0042b28d:
  nWindowRet = Storm::_3rdparty::zlib::inflate::updatewindow
                         (nDictLength,(int32_t)(pDictionary + nDictLength),pStream);
  if (nWindowRet == 0) {
    pState->havedict = 1;
    return 0;
  }
  pState->mode = 0x1e;
  return 0xfffffffc;
}


