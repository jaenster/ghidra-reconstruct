
/* @function SOUND_PlaySoundEffect
   @address Game.exe.ram:00514ec0
   @date 2026.06.09
   @calling __fastcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

void __fastcall D2Sound::Src::D2SoundFast::SOUND_PlaySoundEffect(byte *pbParam)

{
  byte *pbCacheEntry;
  int nCmpResult;
  int32_t bIsPlaying;
  byte *pbSearchName;
  byte *pbMatchedEntry;
  bool bLessThan;
  byte byCurChar;
  D2SoundSmpStrc *ppSoundBuffer;
  
  if (gnSoundEffectSampleCount != 0) {
                    /* LPCRITICAL_SECTION lpCriticalSection for EnterCriticalSection */
    EnterCriticalSection(&lpCriticalSection_008817c4);
    pbCacheEntry = gpWavFileCacheListHead;
    pbSearchName = pbParam;
    pbMatchedEntry = gpWavFileCacheListHead;
    if (gpWavFileCacheListHead != (void *)0x0) {
LAB_00514ef4:
      byCurChar = *pbCacheEntry;
      bLessThan = byCurChar < *pbSearchName;
      if (byCurChar == *pbSearchName) {
        if (byCurChar != 0) {
          byCurChar = pbCacheEntry[1];
          bLessThan = byCurChar < pbSearchName[1];
          if (byCurChar != pbSearchName[1]) goto LAB_00514f14;
          pbCacheEntry = pbCacheEntry + 2;
          pbSearchName = pbSearchName + 2;
          if (byCurChar != 0) goto LAB_00514ef4;
        }
        nCmpResult = 0;
      }
      else {
LAB_00514f14:
        nCmpResult = (1 - (uint)bLessThan) - (uint)(bLessThan != 0);
      }
      if (nCmpResult != 0) goto code_r0x00514f1d;
      nCmpResult = 0;
      while ((gpaSoundEffectBuffers[nCmpResult]->dwFlags != *(int *)(pbMatchedEntry + 0x58) ||
             (bIsPlaying = D2Sound::Src::D2SoundSmp::SOUNDSMP_IsPlaying
                                     (gpaSoundEffectBuffers[nCmpResult]), bIsPlaying != 0))) {
        nCmpResult = nCmpResult + 1;
        if (7 < nCmpResult) {
                    /* LPCRITICAL_SECTION lpCriticalSection for LeaveCriticalSection */
          LeaveCriticalSection(&lpCriticalSection_008817c4);
          return;
        }
      }
      if (nCmpResult < 8) {
        ppSoundBuffer = gpaSoundEffectBuffers[nCmpResult];
        D2Sound::Src::D2SoundSmp::SOUNDSMP_Reset(ppSoundBuffer);
        D2Sound::Src::D2SoundSmp::SOUNDSMP_LoadWavDataIntoBuffer
                  (ppSoundBuffer,*(int **)(pbMatchedEntry + 0x50),*(int **)(pbMatchedEntry + 0x54));
        D2Sound::Src::D2SoundSmp::SOUNDSMP_SetVolume(ppSoundBuffer,(int *)0xff);
        D2Sound::Src::D2SoundSmp::SOUNDSMP_Play(ppSoundBuffer);
      }
    }
                    /* LPCRITICAL_SECTION lpCriticalSection for LeaveCriticalSection */
    LeaveCriticalSection(&lpCriticalSection_008817c4);
  }
  return;
code_r0x00514f1d:
  pbCacheEntry = *(byte **)(pbMatchedEntry + 0x5c);
  pbSearchName = pbParam;
  pbMatchedEntry = pbCacheEntry;
  if (pbCacheEntry == (byte *)0x0) {
                    /* LPCRITICAL_SECTION lpCriticalSection for LeaveCriticalSection */
    LeaveCriticalSection(&lpCriticalSection_008817c4);
    return;
  }
  goto LAB_00514ef4;
}

