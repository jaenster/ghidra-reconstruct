/* WARNING: Function: __alloca_probe replaced with injection: alloca_probe */
/* @function ShowOogErrorDialog
   @address Game.exe.ram:0043b9f0
   @date 2026.06.13
   @calling __fastcall
   @description Displays out-of-game error/message dialogs. Error code determines which localized
   string to show. Custom data used for character names or custom messages. */

int __fastcall D2Launch::Launcher::ShowOogErrorDialog(D2OogErrorDataStrc *pErrorData)

{
  eOogErrorCode eVar1;
  int32_t nErrorAddress;
  int nTitleStrId;
  int nPopupType;
  uint16_t nBodyStrId;
  WCHAR *pwszClearCursor;
  int32_t nLine;
  WCHAR awszCharName [512];
  WCHAR awszFooter [512];
  WCHAR awszTitle [512];
  WCHAR awszBody [512];
  int nFooterStrId;
  int bDisconnectOnClose;
  pfnUIMenuInstance *pfnOnClose;
  size_t cchBufferSize;
  
  eVar1 = pErrorData->eErrorCode;
  pwszClearCursor = awszBody;
  for (nTitleStrId = 0x100; nTitleStrId != 0; nTitleStrId = nTitleStrId + -1) {
    pwszClearCursor[0] = L'\0';
    pwszClearCursor[1] = L'\0';
    pwszClearCursor = pwszClearCursor + 2;
  }
  pwszClearCursor = awszFooter;
  for (nTitleStrId = 0x100; nTitleStrId != 0; nTitleStrId = nTitleStrId + -1) {
    pwszClearCursor[0] = L'\0';
    pwszClearCursor[1] = L'\0';
    pwszClearCursor = pwszClearCursor + 2;
  }
  pwszClearCursor = awszTitle;
  for (nTitleStrId = 0x100; nTitleStrId != 0; nTitleStrId = nTitleStrId + -1) {
    pwszClearCursor[0] = L'\0';
    pwszClearCursor[1] = L'\0';
    pwszClearCursor = pwszClearCursor + 2;
  }
  bDisconnectOnClose = 1;
  pfnOnClose = D2Launch::MainMenus::UIMENU_MainMenu;
  nFooterStrId = -1;
  awszTitle[0] = L'\0';
  awszFooter[0] = L'\0';
  switch(eVar1) {
  case OOG_ERROR_1:
    nTitleStrId = 0x147d;
    nBodyStrId = 0x1443;
    nFooterStrId = 0x1444;
    goto LAB_0043be09;
  case OOG_ERROR_2:
    nTitleStrId = 0x147e;
    nBodyStrId = 0x143f;
    nPopupType = 1;
    break;
  case OOG_ERROR_3:
  case OOG_ERROR_7:
    nTitleStrId = 0x147f;
    nBodyStrId = (-(ushort)(eVar1 != OOG_ERROR_3) & 0x165e) + 0x1442;
    nFooterStrId = 0x144a;
    goto LAB_0043be09;
  case OOG_ERROR_LOGIN_FAILED:
  case OOG_ERROR_8:
    nTitleStrId = 0x147f;
    nBodyStrId = (-(ushort)(eVar1 != OOG_ERROR_LOGIN_FAILED) & 0x1652) + 0x144f;
    nPopupType = 1;
    break;
  case OOG_ERROR_5:
  case OOG_ERROR_9:
    nTitleStrId = 0x147f;
    nBodyStrId = 0x1452;
    nPopupType = 1;
    break;
  case OOG_ERROR_CHAR_NAME_DIALOG:
  case OOG_ERROR_CHAR_NAME_DIALOG_2:
    Fog::File::CONTAINER_InitializeBuffer
              (awszCharName,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    if (pErrorData->pCustomData != (D2CharSelStrc *)0x0) {
      D2Lang::Unicode::UNISYS::STRING_CopyCharToWCharWithSetMaxSize
                (awszCharName,pErrorData->pCustomData,0x200);
      cchBufferSize = 0x200;
      pwszClearCursor = D2Lang::StrTable::strtable::GetLocaleString(0x147f);
      D2Lang::Unicode::UNISYS::WSTRING_PutWideCharIntoBuffer
                (awszTitle,pwszClearCursor,cchBufferSize);
      cchBufferSize = 0x200;
      pwszClearCursor =
           D2Lang::StrTable::strtable::GetLocaleString
                     ((-(ushort)(pErrorData->eErrorCode != OOG_ERROR_CHAR_NAME_DIALOG) & 0x1652) +
                      0x1450);
      D2Lang::Unicode::UNISYS::WSTRING_PutWideCharIntoBuffer(awszBody,pwszClearCursor,cchBufferSize)
      ;
      cchBufferSize = 0x200;
      pwszClearCursor = D2Lang::StrTable::strtable::GetLocaleString(0x1451);
      D2Lang::Unicode::UNISYS::WSTRING_PutWideCharIntoBuffer
                (awszFooter,pwszClearCursor,cchBufferSize);
      D2Launch::MainMenus::UIMENU_CrashingCantTestIt
                (awszTitle,awszBody,awszCharName,awszFooter,D2Launch::MainMenus::UIMENU_MainMenu);
      return 0;
    }
    nLine = 0x2ad;
    nErrorAddress = Fog::Src::ErrorManager::GetInstructionPointer();
                    /* WARNING: Subroutine does not return */
    Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nErrorAddress,nLine);
  case OOG_ERROR_11:
    nTitleStrId = 0x147f;
    nBodyStrId = 0x14ec;
    nPopupType = 1;
    break;
  case OOG_ERROR_GENERIC:
    nTitleStrId = 0x147f;
    goto LAB_0043bdfd;
  case OOG_ERROR_MAIN_MENU:
    nTitleStrId = 0x147c;
    nBodyStrId = 0x1458;
    nPopupType = 1;
    bDisconnectOnClose = 0;
    pfnOnClose = D2Launch::MainMenus::UIMENU_MainMenuAgain;
    break;
  case OOG_ERROR_BNET_ACCOUNT_CHECK:
    nErrorAddress =
         Storm::Source::SSTR::SStrCmp
                   (gszOogLastIniStringCache,D2IniData_launcher->szLastBnetAccount,0x7fffffff);
    if (nErrorAddress == 0) {
      gnBnetAccountLoginFailCount = gnBnetAccountLoginFailCount + 1;
    }
    else {
      gnBnetAccountLoginFailCount = 1;
      Storm::Source::SSTR::SStrCopy
                (gszOogLastIniStringCache,D2IniData_launcher->szLastBnetAccount,0x10);
    }
    nTitleStrId = 0x147c;
    nPopupType = 1;
    bDisconnectOnClose = 0;
    pfnOnClose = D2Launch::MainMenus::UIMENU_MainMenuAgain;
    if (gnBnetAccountLoginFailCount < 2) {
      nBodyStrId = 0x1457;
    }
    else {
      nBodyStrId = 0x2b63;
      D2Launch::MainMenus::MAINMENU_SetGlobalValue3(1);
    }
    break;
  case OOG_ERROR_15:
    nTitleStrId = 0x147c;
    nBodyStrId = 0x1459;
    nPopupType = 1;
    bDisconnectOnClose = 0;
    pfnOnClose = D2Launch::MainMenus::UIMENU_MainMenuAgain;
    break;
  case OOG_ERROR_CONNECT_16:
    nTitleStrId = 0x1480;
    nBodyStrId = 0x14e5;
    nPopupType = 1;
    break;
  case OOG_ERROR_CONNECT_17:
    nTitleStrId = 0x1480;
    nBodyStrId = 0x14ea;
    nPopupType = 1;
    break;
  case OOG_ERROR_CONNECT_18:
    nTitleStrId = 0x1480;
    nBodyStrId = 0x14e3;
    nPopupType = 1;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_1:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x146f;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_2:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x1470;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_3:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x1471;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_4:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x1477;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_5:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x1472;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_6:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x1473;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_7:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x1474;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CREATE_ACCOUNT_8:
    nTitleStrId = 0x1481;
    nBodyStrId = 0x1475;
    nPopupType = 1;
    pfnOnClose = D2Launch::MainMenus::UIMENU_CreateBattleNetAccount;
    bDisconnectOnClose = 0;
    break;
  case OOG_ERROR_CUSTOM_MESSAGE:
    D2Lang::Unicode::UNISYS::STRING_ConvertCharToWchar(awszBody,pErrorData->pCustomData,0x200);
    cchBufferSize = 0x200;
    pwszClearCursor = D2Lang::StrTable::strtable::GetLocaleString(0x147c);
    D2Lang::Unicode::UNISYS::WSTRING_PutWideCharIntoBuffer(awszTitle,pwszClearCursor,cchBufferSize);
    D2Launch::MainMenus::UIMENU_CreatePopupWithContent
              (awszTitle,awszBody,D2Launch::MainMenus::UIMENU_MainMenuAgain);
    return 0;
  default:
    nTitleStrId = 0x1480;
LAB_0043bdfd:
    nFooterStrId = 0x1446;
    nBodyStrId = 0x1445;
LAB_0043be09:
    nPopupType = 2;
  }
  cchBufferSize = 0x200;
  pwszClearCursor = D2Lang::StrTable::strtable::GetLocaleString(nBodyStrId);
  D2Lang::Unicode::UNISYS::WSTRING_PutWideCharIntoBuffer(awszBody,pwszClearCursor,cchBufferSize);
  if (nFooterStrId != -1) {
    cchBufferSize = 0x200;
    pwszClearCursor = D2Lang::StrTable::strtable::GetLocaleString((uint16_t)nFooterStrId);
    D2Lang::Unicode::UNISYS::WSTRING_PutWideCharIntoBuffer(awszFooter,pwszClearCursor,cchBufferSize)
    ;
  }
  if (nTitleStrId != -1) {
    cchBufferSize = 0x200;
    pwszClearCursor = D2Lang::StrTable::strtable::GetLocaleString((uint16_t)nTitleStrId);
    D2Lang::Unicode::UNISYS::WSTRING_PutWideCharIntoBuffer(awszTitle,pwszClearCursor,cchBufferSize);
  }
  if (nPopupType == 0) {
    D2Launch::MainMenus::MAINMENU_ShowPopupWithCancel(awszBody,pfnOnClose);
  }
  else if (nPopupType == 1) {
    D2Launch::MainMenus::UIMENU_CreatePopupWithContent(awszTitle,awszBody,pfnOnClose);
  }
  else {
    D2Launch::MainMenus::UIMENU_CreatePopupWithContentAndFooter
              (awszTitle,awszBody,awszFooter,pfnOnClose);
  }
  if (bDisconnectOnClose != 0) {
    D2MCPClient::McpConnect::FreeMCP();
    (*gpBNetCallbacks->pfnDisconnect)();
  }
  return 0;
}

