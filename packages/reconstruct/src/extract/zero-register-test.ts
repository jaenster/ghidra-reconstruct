/** Native same-block proof for a register-held zero in an equality-test SUB/ADD. */
export const ZERO_REGISTER_TEST_JAVA = `
          final java.util.function.BiPredicate<ghidra.program.model.listing.Instruction, ghidra.program.model.lang.Register> zeroBeforeTest = (at, reg) -> {
            if (reg == null || reg.getBitLength() != 32 || !reg.equals(reg.getBaseRegister())
                || !reg.getName().matches("E(AX|BX|CX|DX|SI|DI|BP)")) return false;
            ghidra.program.model.listing.Instruction cur = at;
            for (int z = 0; z < 16; z++) {
              if (cur.getAddress().equals(fn.getEntryPoint())) return false;
              for (ghidra.program.model.symbol.Reference ref : prog.getReferenceManager().getReferencesTo(cur.getAddress()))
                if (ref.getReferenceType().isFlow()) return false;
              ghidra.program.model.listing.Instruction prev = prog.getListing().getInstructionBefore(cur.getAddress());
              if (prev == null || !fn.getBody().contains(prev.getAddress()) || prev.getFallThrough() == null
                  || !prev.getFallThrough().equals(cur.getAddress()) || prev.getFlowType().isCall()
                  || prev.getFlowType().isJump() || prev.getFlowType().isTerminal()) return false;
              boolean writes = false;
              for (Object result : prev.getResultObjects()) {
                if (result instanceof ghidra.program.model.lang.Register
                    && ((ghidra.program.model.lang.Register) result).getBaseRegister().equals(reg)) writes = true;
              }
              if (writes) {
                if (prev.getNumOperands() != 2 || !reg.equals(prev.getRegister(0))) return false;
                String mnemonic = prev.getMnemonicString();
                if ((mnemonic.equals("XOR") || mnemonic.equals("SUB")) && reg.equals(prev.getRegister(1))) return true;
                return mnemonic.equals("MOV")
                  && ghidra.program.model.lang.OperandType.isScalar(prev.getOperandType(1))
                  && prev.getScalar(1) != null && prev.getScalar(1).getValue() == 0;
              }
              cur = prev;
            }
            return false;
          };
`;

/** Shared by the merged reader and standalone branch-layout reader. Locals: in, m, d. */
export const EQUALITY_TEST_DELTA_JAVA = `
                  if ((m.equals("SUB") || m.equals("ADD")) && in.getNumOperands() == 2) {
                    if (ghidra.program.model.lang.OperandType.isScalar(in.getOperandType(1)) && in.getScalar(1) != null) {
                      long value = in.getScalar(1).getSignedValue();
                      d = Long.toString(m.equals("SUB") ? value : -value);
                    } else if (ghidra.program.model.lang.OperandType.isRegister(in.getOperandType(0))
                        && ghidra.program.model.lang.OperandType.isRegister(in.getOperandType(1))
                        && in.getRegister(0) != null && in.getRegister(0).getBitLength() == 32
                        && zeroBeforeTest.test(in, in.getRegister(1))) d = "0";
                  } else if (m.equals("DEC")) d = "1";
                  else if (m.equals("INC")) d = "-1";
`;
