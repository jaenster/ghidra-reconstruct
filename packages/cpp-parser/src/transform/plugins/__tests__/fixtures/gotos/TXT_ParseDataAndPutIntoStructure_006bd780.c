
/* @function TXT_ParseDataAndPutIntoStructure
   @address Game.exe.ram:006bd780
   @date 2026.09.05
   @calling __stdcall */

void Fog::Src::Excel::Excel::TXT_ParseDataAndPutIntoStructure
               (D2BinFieldExcelStrc *pBinFieldExcel,D2BinFieldInputStrc *pBinFieldInput,
               D2ArchiveStrc *pStruct,size_t nLinesCount,int nEndOffset)

{
  char cCurChar;
  int32_t nAddress;
  int nMappedFieldCount;
  int32_t nResolvedLinkId;
  uint nParsedInt;
  int iVar1;
  char *pLinker;
  char *pSrcChar;
  int nLinkId;
  char *pCurDataPos;
  char *pDstChar;
  int nLineIndex;
  D2ArchiveStrc *pCurrentRecord;
  int nColIndex;
  uint32_t dwCodePadded;
  ushort aColumnFieldMap [280];
  char aFieldParseBuf [288];
  undefined4 dwCodeBuf;
  char cLinkNameTerm;
  uint dwSecurityCookie;
  size_t nFieldSize;
  uint32_t nOffset;
  eD2BinFieldInputType eFieldType3;
  eD2BinFieldInputType eFieldType;
  eD2BinFieldInputType eFieldType2;
  bool bHasLinkFields;
  int32_t dwErrorLine;
  ushort nFieldMapIdx;
  code *pFieldDest;
  uint32_t pItemsTxt;
  
  dwSecurityCookie = DEFAULT_SECURITY_COOKIE ^ (uint)&stack0xfffffffc;
  pCurrentRecord = pStruct;
  if (nLinesCount == 0) {
    dwErrorLine = 0x112;
  }
  else {
    if (nEndOffset != 0) {
      nMappedFieldCount =
           Fog::Src::Excel::Excel::FOG_ParseBinField
                     ((int)aColumnFieldMap,pBinFieldExcel,pBinFieldInput);
      iVar1 = pBinFieldExcel->nColumnCount;
      bHasLinkFields = false;
      nLinkId = 0;
      if (0 < iVar1) {
        do {
          if ((aColumnFieldMap[nLinkId] != 0x7fff) && (true)) {
            switch(pBinFieldInput[aColumnFieldMap[nLinkId]].eType) {
            case FIELDTYPE_CODE4:
            case FIELDTYPE_CODE1:
            case FIELDTYPE_CODE2:
            case FIELDTYPE_NAME_I:
            case FIELDTYPE_NAME_I_WORD:
            case FIELDTYPE_NAME_I_INT:
              bHasLinkFields = true;
            }
          }
          nLinkId = nLinkId + 1;
        } while (nLinkId < iVar1);
      }
      if (bHasLinkFields) {
        pCurDataPos = pBinFieldExcel->pDataStart;
        nLineIndex = 0;
        if (0 < (int)pBinFieldExcel->nLinesCount) {
          do {
            nColIndex = 0;
            if (0 < iVar1) {
              do {
                nFieldMapIdx = aColumnFieldMap[nColIndex];
                if (nFieldMapIdx == 0x7fff) {
                  cCurChar = *pCurDataPos;
                  while (cCurChar != '\0') {
                    pCurDataPos = pCurDataPos + 1;
                    cCurChar = *pCurDataPos;
                  }
LAB_006bda9e:
                  pCurDataPos = pCurDataPos + 1;
                }
                else {
                  pDstChar = pCurrentRecord->szArchivePath +
                             pBinFieldInput[nFieldMapIdx].nOffset + -8;
                  if (false) {
switchD_006bd8ed_caseD_b:
                    cCurChar = *pCurDataPos;
                    while (cCurChar != '\0') {
                      pCurDataPos = pCurDataPos + 1;
                      cCurChar = *pCurDataPos;
                    }
                    goto LAB_006bda9e;
                  }
                  switch(pBinFieldInput[nFieldMapIdx].eType) {
                  case FIELDTYPE_CODE4:
                  case FIELDTYPE_CODE1:
                  case FIELDTYPE_CODE2:
                    dwCodeBuf = 0;
                    cCurChar = *pCurDataPos;
                    iVar1 = 0;
                    pItemsTxt = dwCodeBuf;
joined_r0x006bd8ff:
                    dwCodeBuf = pItemsTxt;
                    if (cCurChar != '\0') {
                      if (iVar1 < 4) goto code_r0x006bd906;
                      cCurChar = *pCurDataPos;
                      while (cCurChar != '\0') {
                        pCurDataPos = pCurDataPos + 1;
                        cCurChar = *pCurDataPos;
                      }
                    }
                    pCurDataPos = pCurDataPos + 1;
                    if ((char)pItemsTxt == '\0') {
                      dwCodePadded = 0x20202020;
                    }
                    else if ((char)(pItemsTxt >> 8) == '\0') {
                      dwCodePadded._0_2_ = CONCAT11(0x20,(char)pItemsTxt);
                      dwCodePadded._0_3_ = CONCAT12(0x20,(undefined2)dwCodePadded);
                      dwCodePadded = CONCAT13(0x20,(undefined3)dwCodePadded);
                    }
                    else {
                      dwCodeBuf._2_1_ = (char)(pItemsTxt >> 0x10);
                      dwCodePadded._0_2_ = (undefined2)pItemsTxt;
                      if (dwCodeBuf._2_1_ == '\0') {
                        dwCodePadded._0_3_ = CONCAT12(0x20,(undefined2)dwCodePadded);
                        dwCodePadded = CONCAT13(0x20,(undefined3)dwCodePadded);
                      }
                      else {
                        dwCodePadded._0_3_ = (undefined3)pItemsTxt;
                        dwCodePadded = CONCAT13(0x20,(undefined3)dwCodePadded);
                        dwCodeBuf._3_1_ = (char)(pItemsTxt >> 0x18);
                        if (dwCodeBuf._3_1_ != '\0') {
                          dwCodePadded = pItemsTxt;
                        }
                      }
                    }
                    pItemsTxt = Fog::Src::Excel::Excel::FillUpTxtLinkSub0x08
                                          (*(D2TxtLinkStrc **)pBinFieldInput[nFieldMapIdx].fpLinker,
                                           (char *)dwCodePadded);
                    eFieldType3 = pBinFieldInput[nFieldMapIdx].eType;
                    if (eFieldType3 == FIELDTYPE_CODE4) {
                      *(uint32_t *)pDstChar = dwCodePadded;
                    }
                    else if (eFieldType3 == FIELDTYPE_CODE1) {
                      if (0xff < (int)pItemsTxt) {
                        dwErrorLine = 0x156;
                        goto LAB_006bd7c5;
                      }
                      *pDstChar = (char)dwCodePadded;
                    }
                    else if (eFieldType3 == FIELDTYPE_CODE2) {
                      if (0xffff < (int)pItemsTxt) {
                        dwErrorLine = 0x15a;
                        goto LAB_006bd7c5;
                      }
                      *(undefined2 *)pDstChar = (undefined2)dwCodePadded;
                    }
                    break;
                  default:
                    goto switchD_006bd8ed_caseD_b;
                  case FIELDTYPE_NAME_I:
                    cCurChar = *pCurDataPos;
                    nFieldSize = pBinFieldInput[nFieldMapIdx].nSize;
                    for (pSrcChar = pDstChar;
                        (cCurChar != '\0' && (pSrcChar < pDstChar + (nFieldSize - 1)));
                        pSrcChar = pSrcChar + 1) {
                      pCurDataPos = pCurDataPos + 1;
                      *pSrcChar = cCurChar;
                      cCurChar = *pCurDataPos;
                    }
                    *pSrcChar = '\0';
                    cCurChar = *pCurDataPos;
                    while (cCurChar != '\0') {
                      pCurDataPos = pCurDataPos + 1;
                      cCurChar = *pCurDataPos;
                    }
                    pCurDataPos = pCurDataPos + 1;
                    Fog::Src::Excel::Excel::FOG_ParseStringField
                              (*(int **)pBinFieldInput[nFieldMapIdx].fpLinker,pDstChar);
                    break;
                  case FIELDTYPE_NAME_I_WORD:
                  case FIELDTYPE_NAME_I_INT:
                    cCurChar = *pCurDataPos;
                    for (pDstChar = aFieldParseBuf + 0x100;
                        (cCurChar != '\0' && (pDstChar < aFieldParseBuf + 0x11f));
                        pDstChar = pDstChar + 1) {
                      pCurDataPos = pCurDataPos + 1;
                      *pDstChar = cCurChar;
                      cCurChar = *pCurDataPos;
                    }
                    cCurChar = *pCurDataPos;
                    *pDstChar = '\0';
                    while (cCurChar != '\0') {
                      pCurDataPos = pCurDataPos + 1;
                      cCurChar = *pCurDataPos;
                    }
                    pCurDataPos = pCurDataPos + 1;
                    nResolvedLinkId =
                         Fog::Src::Excel::Excel::FOG_ParseTxtLink
                                   (*(D2TxtLinkStrc **)pBinFieldInput[nFieldMapIdx].fpLinker,
                                    aFieldParseBuf + 0x100);
                    if (pBinFieldInput[nFieldMapIdx].eType == FIELDTYPE_NAME_I_WORD) {
                      *(short *)(pCurrentRecord->szArchivePath +
                                pBinFieldInput[nFieldMapIdx].nOffset + -8) = (short)nResolvedLinkId;
                    }
                    else {
                      *(int32_t *)
                       (pCurrentRecord->szArchivePath + pBinFieldInput[nFieldMapIdx].nOffset + -8) =
                           nResolvedLinkId;
                    }
                  }
                }
                iVar1 = pBinFieldExcel->nColumnCount;
                nColIndex = nColIndex + 1;
              } while (nColIndex < iVar1);
            }
            if (*pCurDataPos != '\n') {
              dwErrorLine = 0x185;
              goto LAB_006bd7c5;
            }
            pCurrentRecord = (D2ArchiveStrc *)(pCurrentRecord->szArchivePath + nEndOffset + -8);
            nLineIndex = nLineIndex + 1;
            pCurDataPos = pCurDataPos + 1;
          } while (nLineIndex < (int)pBinFieldExcel->nLinesCount);
        }
      }
      pCurDataPos = pBinFieldExcel->pDataStart;
      nLineIndex = 0;
      if ((int)pBinFieldExcel->nLinesCount < 1) {
        Fog::Debug::GuardStack();
        return;
      }
      do {
        nColIndex = 0;
        pDstChar = pCurDataPos;
        if (0 < pBinFieldExcel->nColumnCount) {
          do {
            nFieldMapIdx = aColumnFieldMap[nColIndex];
            if (nFieldMapIdx == 0x7fff) {
              cCurChar = *pCurDataPos;
              while (cCurChar != '\0') {
                pCurDataPos = pCurDataPos + 1;
                cCurChar = *pCurDataPos;
              }
              pDstChar = pCurDataPos + 1;
            }
            else {
              dwErrorLine = pBinFieldInput[nFieldMapIdx].nOffset;
              pSrcChar = pStruct->szArchivePath + dwErrorLine + -8;
              pItemsTxt = pBinFieldInput[nFieldMapIdx].nSize;
              pDstChar = pSrcChar + pItemsTxt;
                    /* WARNING: Switch is manually overridden */
              switch(*(undefined1 *)
                      ((int)Fog::Src::Excel::Excel::TXT_ParseFieldTypeJumpTable +
                      pBinFieldInput[nFieldMapIdx].eType + (FIELDTYPE_LINKER_UNK|FIELDTYPE_ASCII2)))
              {
              case 0:
                cCurChar = *pCurDataPos;
                pLinker = pCurDataPos;
                if (cCurChar == '\0') {
LAB_006bdc19:
                  pDstChar = pCurDataPos + 1;
                  *pSrcChar = '\0';
                }
                else {
                  do {
                    pCurDataPos = pLinker;
                    if (pDstChar <= pSrcChar) {
                      cCurChar = *pCurDataPos;
                      while (cCurChar != '\0') {
                        pCurDataPos = pCurDataPos + 1;
                        cCurChar = *pCurDataPos;
                      }
                      goto LAB_006bdc19;
                    }
                    *pSrcChar = cCurChar;
                    cCurChar = pCurDataPos[1];
                    pSrcChar = pSrcChar + 1;
                    pLinker = pCurDataPos + 1;
                  } while (cCurChar != '\0');
                  pDstChar = pCurDataPos + 2;
                  *pSrcChar = '\0';
                }
                break;
              case 1:
                pDstChar = pCurDataPos;
                if (*pCurDataPos == '-') {
                  pDstChar = pCurDataPos + 1;
                }
                nParsedInt = 0;
                cCurChar = *pDstChar;
                while (cCurChar != '\0') {
                  pDstChar = pDstChar + 1;
                  nParsedInt = cCurChar + -0x30 + nParsedInt * 10;
                  cCurChar = *pDstChar;
                }
                if (*pCurDataPos == '-') {
                  nParsedInt = -nParsedInt;
                }
                pDstChar = pDstChar + 1;
                if (true) {
                  switch(pBinFieldInput[nFieldMapIdx].eType) {
                  case FIELDTYPE_INT:
                  case FIELDTYPE_UINT:
                    goto switchD_006bde56_caseD_2;
                  case FIELDTYPE_SHORT:
switchD_006bde56_caseD_3:
                    *(short *)pSrcChar = (short)nParsedInt;
                    break;
                  case FIELDTYPE_CHAR:
                  case FIELDTYPE_BYTE:
switchD_006bde56_caseD_4:
                    *pSrcChar = (char)nParsedInt;
                    break;
                  case FIELDTYPE_BOOL:
                    if (pCurDataPos + 1 != pDstChar) {
                      *pSrcChar = (char)nParsedInt;
                    }
                    break;
                  case FIELDTYPE_BIT:
                    if (nParsedInt == 0) {
                      Fog::BitBuffer::UnsetBitAtOffset(pSrcChar,pItemsTxt);
                    }
                    else {
                      Fog::BitBuffer::SetBitAtOffset(pSrcChar,pItemsTxt);
                    }
                  }
                }
                break;
              case 2:
                iVar1 = 0;
                dwCodeBuf = 0;
                cCurChar = *pCurDataPos;
                pItemsTxt = dwCodeBuf;
joined_r0x006bdc2d:
                dwCodeBuf = pItemsTxt;
                if (cCurChar != '\0') {
                  if (iVar1 < 4) goto code_r0x006bdc35;
                  cCurChar = *pCurDataPos;
                  while (cCurChar != '\0') {
                    pCurDataPos = pCurDataPos + 1;
                    cCurChar = *pCurDataPos;
                  }
                }
                dwCodeBuf._0_1_ = (char)pItemsTxt;
                pDstChar = pCurDataPos + 1;
                if ((char)dwCodeBuf == '\0') {
                  builtin_strncpy(pStruct->szArchivePath + dwErrorLine + -8,"    ",4);
                }
                else {
                  *pSrcChar = (char)dwCodeBuf;
                  cCurChar = (char)(pItemsTxt >> 8);
                  if (cCurChar == '\0') {
                    pSrcChar[1] = ' ';
                    pSrcChar[2] = ' ';
                    pSrcChar[3] = ' ';
                  }
                  else {
                    pSrcChar[1] = cCurChar;
                    dwCodeBuf._2_1_ = (char)(pItemsTxt >> 0x10);
                    if (dwCodeBuf._2_1_ == '\0') {
                      pSrcChar[2] = ' ';
                      pSrcChar[3] = ' ';
                    }
                    else {
                      pSrcChar[2] = dwCodeBuf._2_1_;
                      dwCodeBuf._3_1_ = (char)(pItemsTxt >> 0x18);
                      if (dwCodeBuf._3_1_ == '\0') {
                        pSrcChar[3] = ' ';
                      }
                      else {
                        pSrcChar[3] = dwCodeBuf._3_1_;
                      }
                    }
                  }
                }
                break;
              case 3:
                cCurChar = *pCurDataPos;
                while (cCurChar != '\0') {
                  pCurDataPos = pCurDataPos + 1;
                  cCurChar = *pCurDataPos;
                }
                pDstChar = pCurDataPos + 1;
                break;
              case 4:
                dwCodeBuf = 0;
                cCurChar = *pCurDataPos;
                iVar1 = 0;
                if (cCurChar != '\0') {
LAB_006bdce4:
                  if (iVar1 < 4) goto code_r0x006bdce9;
                  cCurChar = *pCurDataPos;
                  while (cCurChar != '\0') {
                    pCurDataPos = pCurDataPos + 1;
                    cCurChar = *pCurDataPos;
                  }
                }
LAB_006bdd0b:
                pDstChar = pCurDataPos + 1;
                if ((char)dwCodeBuf == '\0') {
                  dwCodePadded = 0x20202020;
                }
                else if ((char)(dwCodeBuf >> 8) == '\0') {
                  dwCodePadded._0_2_ = CONCAT11(0x20,(char)dwCodeBuf);
                  dwCodePadded._0_3_ = CONCAT12(0x20,(undefined2)dwCodePadded);
                  dwCodePadded = CONCAT13(0x20,(undefined3)dwCodePadded);
                }
                else {
                  dwCodePadded._0_2_ = (undefined2)dwCodeBuf;
                  if (dwCodeBuf._2_1_ == '\0') {
                    dwCodePadded._0_3_ = CONCAT12(0x20,(undefined2)dwCodePadded);
                    dwCodePadded = CONCAT13(0x20,(undefined3)dwCodePadded);
                  }
                  else {
                    dwCodePadded._0_3_ = (undefined3)dwCodeBuf;
                    dwCodePadded = CONCAT13(0x20,(undefined3)dwCodePadded);
                    if (dwCodeBuf._3_1_ != '\0') {
                      dwCodePadded = dwCodeBuf;
                    }
                  }
                }
                nParsedInt = Fog::Src::Excel::Excel::GetClassIdFromName
                                       (*(D2TxtLinkStrc **)pBinFieldInput[nFieldMapIdx].fpLinker,
                                        dwCodePadded,1);
                eFieldType2 = pBinFieldInput[nFieldMapIdx].eType;
                if (eFieldType2 == FIELDTYPE_CODE_INT) {
switchD_006bde56_caseD_2:
                  *(uint *)pSrcChar = nParsedInt;
                }
                else {
                  if (eFieldType2 == FIELDTYPE_CODE_CHAR) goto switchD_006bde56_caseD_4;
                  if (eFieldType2 == FIELDTYPE_CODE_SHORT) {
                    *(short *)pSrcChar = (short)nParsedInt;
                  }
                }
                break;
              case 5:
                cCurChar = *pCurDataPos;
                for (pDstChar = (char *)&dwCodeBuf;
                    (cCurChar != '\0' && (pDstChar < &cLinkNameTerm)); pDstChar = pDstChar + 1) {
                  pCurDataPos = pCurDataPos + 1;
                  *pDstChar = cCurChar;
                  cCurChar = *pCurDataPos;
                }
                *pDstChar = '\0';
                cCurChar = *pCurDataPos;
                while (cCurChar != '\0') {
                  pCurDataPos = pCurDataPos + 1;
                  cCurChar = *pCurDataPos;
                }
                pDstChar = pCurDataPos + 1;
                nParsedInt = Fog::Src::Excel::Excel::GetLinkNodeIndex
                                       (*(D2TxtLinkStrc **)pBinFieldInput[nFieldMapIdx].fpLinker,
                                        (char *)&dwCodeBuf,1);
                eFieldType = pBinFieldInput[nFieldMapIdx].eType;
                if (eFieldType == FIELDTYPE_NAME_INT) goto switchD_006bde56_caseD_2;
                if (eFieldType == FIELDTYPE_NAME_SHORT) goto switchD_006bde56_caseD_3;
                if (eFieldType == FIELDTYPE_NAME_CHAR) goto switchD_006bde56_caseD_4;
                break;
              case 6:
                cCurChar = *pCurDataPos;
                pLinker = aFieldParseBuf;
joined_r0x006bdeae:
                if (cCurChar != '\0') {
                  if (pLinker < aFieldParseBuf + 0x100) goto code_r0x006bdeb7;
                  cCurChar = *pCurDataPos;
                  while (cCurChar != '\0') {
                    pCurDataPos = pCurDataPos + 1;
                    cCurChar = *pCurDataPos;
                  }
                }
                pFieldDest = pBinFieldInput[nFieldMapIdx].fpLinker;
                pDstChar = pCurDataPos + 1;
                *pLinker = '\0';
                if (pFieldDest != (code *)0x0) {
                  nParsedInt = (*pFieldDest)(aFieldParseBuf);
                  goto switchD_006bde56_caseD_3;
                }
                break;
              case 7:
                cCurChar = *pCurDataPos;
                pSrcChar = aFieldParseBuf;
joined_r0x006bdefc:
                if (cCurChar != '\0') {
                  if (pSrcChar < aFieldParseBuf + 0x100) goto code_r0x006bdf07;
                  cCurChar = *pCurDataPos;
                  while (cCurChar != '\0') {
                    pCurDataPos = pCurDataPos + 1;
                    cCurChar = *pCurDataPos;
                  }
                }
                pFieldDest = pBinFieldInput[nFieldMapIdx].fpLinker;
                pDstChar = pCurDataPos + 1;
                *pSrcChar = '\0';
                if (pFieldDest != (code *)0x0) {
                  (*pFieldDest)(aFieldParseBuf,pStruct,dwErrorLine,pItemsTxt,nLineIndex,nColIndex);
                }
                break;
              }
            }
            nColIndex = nColIndex + 1;
            pCurDataPos = pDstChar;
          } while (nColIndex < pBinFieldExcel->nColumnCount);
        }
        for (; nColIndex < nMappedFieldCount; nColIndex = nColIndex + 1) {
          nFieldMapIdx = aColumnFieldMap[nColIndex];
          dwErrorLine = pBinFieldInput[nFieldMapIdx].nOffset;
                    /* WARNING: Switch is manually overridden */
          switch(pBinFieldInput[nFieldMapIdx].eType) {
          default:
            pStruct->szArchivePath[dwErrorLine + -8] = '\0';
            break;
          case FIELDTYPE_INT:
          case FIELDTYPE_UINT:
          case FIELDTYPE_RAW4:
          case FIELDTYPE_CODE4:
          case FIELDTYPE_NAME_I_INT:
            pCurDataPos = pStruct->szArchivePath + dwErrorLine + -8;
            pCurDataPos[0] = '\0';
            pCurDataPos[1] = '\0';
            pCurDataPos[2] = '\0';
            pCurDataPos[3] = '\0';
            break;
          case FIELDTYPE_SHORT:
          case FIELDTYPE_CODE2:
          case FIELDTYPE_NAME_I_WORD:
          case FIELDTYPE_KEY_WORD:
            (pStruct->szArchivePath + dwErrorLine + -8)[0] = '\0';
            (pStruct->szArchivePath + dwErrorLine + -8)[1] = '\0';
            break;
          case FIELDTYPE_CODE_INT:
            pCurDataPos = pStruct->szArchivePath + dwErrorLine + -8;
            pCurDataPos[0] = -1;
            pCurDataPos[1] = -1;
            pCurDataPos[2] = -1;
            pCurDataPos[3] = -1;
            break;
          case FIELDTYPE_CODE_CHAR:
          case FIELDTYPE_NAME_CHAR:
            pStruct->szArchivePath[dwErrorLine + -8] = -1;
            break;
          case FIELDTYPE_CODE_SHORT:
          case FIELDTYPE_NAME_SHORT:
            (pStruct->szArchivePath + dwErrorLine + -8)[0] = -1;
            (pStruct->szArchivePath + dwErrorLine + -8)[1] = -1;
            break;
          case FIELDTYPE_NAME_INT:
            pCurDataPos = pStruct->szArchivePath + dwErrorLine + -8;
            pCurDataPos[0] = -1;
            pCurDataPos[1] = -1;
            pCurDataPos[2] = -1;
            pCurDataPos[3] = -1;
            break;
          case FIELDTYPE_LINKER_BIT:
          case FIELDTYPE_LINKER_UNK:
          case FIELDTYPE_LINKER_INT:
            if (pBinFieldInput[nFieldMapIdx].fpLinker != (code *)0x0) {
              (*pBinFieldInput[nFieldMapIdx].fpLinker)
                        ((char *)0x0,pStruct,dwErrorLine,pBinFieldInput[nFieldMapIdx].nSize,
                         nLineIndex,nColIndex);
            }
            break;
          case FIELDTYPE_BIT:
            break;
          }
        }
        if (*pDstChar != '\n') {
          dwErrorLine = 0x286;
          goto LAB_006bd7c5;
        }
        pStruct = (D2ArchiveStrc *)(pStruct->szArchivePath + nEndOffset + -8);
        nLineIndex = nLineIndex + 1;
        pCurDataPos = pDstChar + 1;
        if ((int)pBinFieldExcel->nLinesCount <= nLineIndex) {
          Fog::Debug::GuardStack();
          return;
        }
      } while( true );
    }
    dwErrorLine = 0x113;
  }
LAB_006bd7c5:
  nAddress = Fog::Src::ErrorManager::GetInstructionPointer();
  Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nAddress,dwErrorLine);
                    /* WARNING: Subroutine does not return */
  compiler::_exit(-1);
code_r0x006bd906:
  pCurDataPos = pCurDataPos + 1;
  *(char *)((int)&dwCodeBuf + iVar1) = cCurChar;
  cCurChar = *pCurDataPos;
  iVar1 = iVar1 + 1;
  pItemsTxt = dwCodeBuf;
  goto joined_r0x006bd8ff;
code_r0x006bdf07:
  pCurDataPos = pCurDataPos + 1;
  *pSrcChar = cCurChar;
  cCurChar = *pCurDataPos;
  pSrcChar = pSrcChar + 1;
  goto joined_r0x006bdefc;
code_r0x006bdeb7:
  pCurDataPos = pCurDataPos + 1;
  *pLinker = cCurChar;
  cCurChar = *pCurDataPos;
  pLinker = pLinker + 1;
  goto joined_r0x006bdeae;
code_r0x006bdce9:
  pCurDataPos = pCurDataPos + 1;
  *(char *)((int)&dwCodeBuf + iVar1) = cCurChar;
  cCurChar = *pCurDataPos;
  iVar1 = iVar1 + 1;
  if (cCurChar == '\0') goto LAB_006bdd0b;
  goto LAB_006bdce4;
code_r0x006bdc35:
  pCurDataPos = pCurDataPos + 1;
  *(char *)((int)&dwCodeBuf + iVar1) = cCurChar;
  cCurChar = *pCurDataPos;
  iVar1 = iVar1 + 1;
  pItemsTxt = dwCodeBuf;
  goto joined_r0x006bdc2d;
}

