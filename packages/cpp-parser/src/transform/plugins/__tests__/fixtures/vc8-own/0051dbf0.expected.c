int dummy(pfnNewsEntryCallback pfnMotdCallback, pfnVoidNoArgCallback pfnNewsCallback) {
  g_pfnNewsChannelCallback = 1;
  g_pfnMotdCallback = pfnMotdCallback;
  g_pfnNewsCallback = pfnNewsCallback;
  if (g_nNewsMaxCacheSize.pEntries) {
    Storm::Source::SMem::SMemFree(g_nNewsMaxCacheSize.pEntries, s___AUItem_NewsTable___0072ff8c, -2, 0);
  }
  g_nNewsMaxCacheSize.nCapacity = 0;
  g_nNewsMaxCacheSize.nCount = 0;
  g_nNewsMaxCacheSize.pEntries = 0;
  g_dwNewsTimestamp = 0;
  g_nFirstUnreadNewsIndex = 0;
  BOOL bCacheLoaded = BNNEWS_LoadCachedNews();
  if (bCacheLoaded) {
    BNNEWS_InvokeCallbacks();
  }
  uint32_t dwTimestampPacket = g_dwNewsTimestamp;
  NET_SID_CLIENT_Send(0x46, (char*)&dwTimestampPacket, 4);
  return 1;
}
