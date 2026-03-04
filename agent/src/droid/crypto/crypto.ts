import Java from "frida-java-bridge";
import type { BaseMessage } from "@/common/hooks/context.js";

const CIPHER_MODES: Record<number, string> = {
  1: "ENCRYPT",
  2: "DECRYPT",
  3: "WRAP",
  4: "UNWRAP",
};

function javaBt(): string[] {
  const frames = Java.use("java.lang.Thread")
    .currentThread()
    .getStackTrace();
  const result: string[] = [];
  for (let i = 2; i < Math.min(frames.length, 20); i++) {
    result.push(frames[i].toString());
  }
  return result;
}

function toBuffer(byteArr: any): ArrayBuffer | null {
  if (!byteArr) return null;
  const len = byteArr.length;
  const buf = new ArrayBuffer(len);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < len; i++) u8[i] = byteArr[i] & 0xff;
  return buf;
}

function toBufferSlice(
  byteArr: any,
  offset: number,
  length: number,
): ArrayBuffer | null {
  if (!byteArr) return null;
  const total = Number(byteArr.length) || 0;
  const start = Math.max(0, Math.min(total, Number(offset) || 0));
  const wanted = Math.max(0, Number(length) || 0);
  const safeLength = Math.max(0, Math.min(total - start, wanted));
  const buf = new ArrayBuffer(safeLength);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < safeLength; i++) u8[i] = byteArr[start + i] & 0xff;
  return buf;
}

let cryptoCallSeq = 1;
function nextCallId(symbol: string): string {
  const id = cryptoCallSeq;
  cryptoCallSeq += 1;
  return `${symbol}#${id}`;
}

interface CipherArgInspection {
  extra: Record<string, unknown>;
  payload: ArrayBuffer | null;
  payloadType: string | null;
}

function javaHook(
  cls: any,
  method: string,
  overload: string[],
  impl: (this: any, ...args: any[]) => any,
): InvocationListener {
  const m = cls[method].overload(...overload);
  m.implementation = impl;
  return {
    detach: () => {
      m.implementation = null;
    },
  };
}

export function cipher() {
  const hooks: InvocationListener[] = [];

  Java.perform(() => {
    const Cipher = Java.use("javax.crypto.Cipher");
    const IvParameterSpec = Java.use("javax.crypto.spec.IvParameterSpec");
    const PBEParameterSpec = Java.use("javax.crypto.spec.PBEParameterSpec");
    const GCMParameterSpec = (() => {
      try {
        return Java.use("javax.crypto.spec.GCMParameterSpec");
      } catch (_) {
        return null;
      }
    })();

    const inspectKey = (key: any): CipherArgInspection => {
      const extra: Record<string, unknown> = {
        keyClass: key?.$className ?? "(unknown)",
      };

      let payload: ArrayBuffer | null = null;
      let payloadType: string | null = null;

      try {
        extra.keyAlgorithm = String(key.getAlgorithm());
      } catch (_) {
        /* ignore */
      }

      try {
        const fmt = key.getFormat();
        extra.keyFormat = fmt === null ? "(null)" : String(fmt);
      } catch (_) {
        /* ignore */
      }

      try {
        const encoded = key.getEncoded();
        const encodedBuf = toBuffer(encoded);
        if (encodedBuf) {
          extra.keyLength = encodedBuf.byteLength;
          extra.keyMaterialCaptured = true;
          payload = encodedBuf;
          payloadType = "key";
        } else {
          extra.keyMaterialCaptured = false;
        }
      } catch (_) {
        extra.keyMaterialCaptured = false;
      }

      return { extra, payload, payloadType };
    };

    const inspectSpec = (spec: any): CipherArgInspection => {
      const extra: Record<string, unknown> = {
        specClass: spec?.$className ?? "(unknown)",
      };

      let payload: ArrayBuffer | null = null;
      let payloadType: string | null = null;

      try {
        const cls = String(spec?.$className ?? "");
        if (cls === "javax.crypto.spec.IvParameterSpec") {
          const casted = Java.cast(spec, IvParameterSpec);
          const iv = casted.getIV();
          const ivBuf = toBuffer(iv);
          extra.specType = "iv";
          extra.ivLength = Number(iv?.length ?? 0);
          if (ivBuf) {
            payload = ivBuf;
            payloadType = "iv";
          }
        } else if (
          cls === "javax.crypto.spec.GCMParameterSpec" &&
          GCMParameterSpec !== null
        ) {
          const casted = Java.cast(spec, GCMParameterSpec);
          const iv = casted.getIV();
          const ivBuf = toBuffer(iv);
          extra.specType = "gcm";
          extra.ivLength = Number(iv?.length ?? 0);
          extra.tagLength = Number(casted.getTLen());
          if (ivBuf) {
            payload = ivBuf;
            payloadType = "iv";
          }
        } else if (cls === "javax.crypto.spec.PBEParameterSpec") {
          const casted = Java.cast(spec, PBEParameterSpec);
          const salt = casted.getSalt();
          const saltBuf = toBuffer(salt);
          extra.specType = "pbe";
          extra.iterations = Number(casted.getIterationCount());
          extra.saltLength = Number(salt?.length ?? 0);
          if (saltBuf) {
            payload = saltBuf;
            payloadType = "salt";
          }
        } else {
          extra.specType = cls || "(unknown)";
          try {
            extra.specValue = String(spec.toString());
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore */
      }

      return { extra, payload, payloadType };
    };

    // getInstance(String)
    hooks.push(
      javaHook(
        Cipher,
        "getInstance",
        ["java.lang.String"],
        function (transformation) {
          const result = this.getInstance(transformation);
          send({
            subject: "crypto",
            category: "cipher",
            symbol: "Cipher.getInstance",
            dir: "enter",
            line: `Cipher.getInstance("${transformation}")`,
            backtrace: javaBt(),
            extra: { transformation: String(transformation) },
          } satisfies BaseMessage);
          return result;
        },
      ),
    );

    // getInstance(String, String)
    hooks.push(
      javaHook(
        Cipher,
        "getInstance",
        ["java.lang.String", "java.lang.String"],
        function (transformation, provider) {
          const result = this.getInstance(transformation, provider);
          send({
            subject: "crypto",
            category: "cipher",
            symbol: "Cipher.getInstance",
            dir: "enter",
            line: `Cipher.getInstance("${transformation}", "${provider}")`,
            backtrace: javaBt(),
            extra: {
              transformation: String(transformation),
              provider: String(provider),
            },
          } satisfies BaseMessage);
          return result;
        },
      ),
    );

    // init(int, Key)
    hooks.push(
      javaHook(
        Cipher,
        "init",
        ["int", "java.security.Key"],
        function (mode, key) {
          const op = CIPHER_MODES[mode] || String(mode);
          const algo = this.getAlgorithm();
          const keyInfo = inspectKey(key);
          const line = `Cipher.init(${op}, ${keyInfo.extra.keyClass ?? key.$className}) [${algo}]`;
          const extra = {
            op,
            algo,
            ...keyInfo.extra,
          };

          if (keyInfo.payload) {
            send(
              {
                subject: "crypto",
                category: "cipher",
                symbol: "Cipher.init",
                dir: "enter",
                line,
                backtrace: javaBt(),
                extra: {
                  ...extra,
                  detailType: keyInfo.payloadType,
                  len: keyInfo.payload.byteLength,
                },
              } satisfies BaseMessage,
              keyInfo.payload,
            );
          } else {
            send({
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.init",
              dir: "enter",
              line,
              backtrace: javaBt(),
              extra,
            } satisfies BaseMessage);
          }

          this.init(mode, key);
        },
      ),
    );

    // init(int, Key, AlgorithmParameterSpec)
    hooks.push(
      javaHook(
        Cipher,
        "init",
        [
          "int",
          "java.security.Key",
          "java.security.spec.AlgorithmParameterSpec",
        ],
        function (mode, key, spec) {
          const op = CIPHER_MODES[mode] || String(mode);
          const algo = this.getAlgorithm();
          const keyInfo = inspectKey(key);
          const specInfo = inspectSpec(spec);

          const line = `Cipher.init(${op}, ${keyInfo.extra.keyClass ?? key.$className}, ${specInfo.extra.specClass ?? spec.$className}) [${algo}]`;
          const extra = {
            op,
            algo,
            ...keyInfo.extra,
            ...specInfo.extra,
          };

          const payload = specInfo.payload ?? keyInfo.payload;
          const payloadType = specInfo.payloadType ?? keyInfo.payloadType;

          if (payload) {
            send(
              {
                subject: "crypto",
                category: "cipher",
                symbol: "Cipher.init",
                dir: "enter",
                line,
                backtrace: javaBt(),
                extra: {
                  ...extra,
                  detailType: payloadType,
                  len: payload.byteLength,
                },
              } satisfies BaseMessage,
              payload,
            );
          } else {
            send({
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.init",
              dir: "enter",
              line,
              backtrace: javaBt(),
              extra,
            } satisfies BaseMessage);
          }

          this.init(mode, key, spec);
        },
      ),
    );

    // doFinal()
    hooks.push(
      javaHook(Cipher, "doFinal", [], function () {
        const algo = this.getAlgorithm();
        const callId = nextCallId("Cipher.doFinal");
        send({
          subject: "crypto",
          category: "cipher",
          symbol: "Cipher.doFinal",
          dir: "enter",
          line: `Cipher.doFinal() [${algo}]`,
          backtrace: javaBt(),
          extra: { algo, callId },
        } satisfies BaseMessage);
        const result = this.doFinal();
        const buf = toBuffer(result);
        if (buf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.doFinal",
              dir: "leave",
              line: `Cipher.doFinal() → [${buf.byteLength}B] [${algo}]`,
              extra: {
                algo,
                callId,
                detailType: "output",
                len: buf.byteLength,
              },
            } satisfies BaseMessage,
            buf,
          );
        }
        return result;
      }),
    );

    // doFinal(byte[])
    hooks.push(
      javaHook(Cipher, "doFinal", ["[B"], function (input) {
        const algo = this.getAlgorithm();
        const callId = nextCallId("Cipher.doFinal");
        const inBuf = toBuffer(input);
        if (inBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.doFinal",
              dir: "enter",
              line: `Cipher.doFinal(input[${inBuf.byteLength}B]) [${algo}]`,
              backtrace: javaBt(),
              extra: {
                algo,
                callId,
                detailType: "input",
                len: inBuf.byteLength,
              },
            } satisfies BaseMessage,
            inBuf,
          );
        }
        const result = this.doFinal(input);
        const outBuf = toBuffer(result);
        if (outBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.doFinal",
              dir: "leave",
              line: `Cipher.doFinal() → [${outBuf.byteLength}B] [${algo}]`,
              extra: {
                algo,
                callId,
                detailType: "output",
                len: outBuf.byteLength,
              },
            } satisfies BaseMessage,
            outBuf,
          );
        }
        return result;
      }),
    );

    // doFinal(byte[], int, int)
    hooks.push(
      javaHook(Cipher, "doFinal", ["[B", "int", "int"], function (
        input,
        offset,
        length,
      ) {
        const algo = this.getAlgorithm();
        const callId = nextCallId("Cipher.doFinal");
        const inBuf = toBufferSlice(input, offset, length);
        if (inBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.doFinal",
              dir: "enter",
              line: `Cipher.doFinal(input[${inBuf.byteLength}B], off=${offset}, len=${length}) [${algo}]`,
              backtrace: javaBt(),
              extra: {
                algo,
                callId,
                offset: Number(offset),
                length: Number(length),
                detailType: "input",
                len: inBuf.byteLength,
              },
            } satisfies BaseMessage,
            inBuf,
          );
        }

        const result = this.doFinal(input, offset, length);
        const outBuf = toBuffer(result);
        if (outBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.doFinal",
              dir: "leave",
              line: `Cipher.doFinal(...) → [${outBuf.byteLength}B] [${algo}]`,
              extra: {
                algo,
                callId,
                detailType: "output",
                len: outBuf.byteLength,
              },
            } satisfies BaseMessage,
            outBuf,
          );
        }
        return result;
      }),
    );

    // doFinal(byte[], int, int, byte[])
    hooks.push(
      javaHook(Cipher, "doFinal", ["[B", "int", "int", "[B"], function (
        input,
        offset,
        length,
        output,
      ) {
        const algo = this.getAlgorithm();
        const callId = nextCallId("Cipher.doFinal");
        const inBuf = toBufferSlice(input, offset, length);
        if (inBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.doFinal",
              dir: "enter",
              line: `Cipher.doFinal(input[${inBuf.byteLength}B], off=${offset}, len=${length}, out[${output?.length ?? 0}B]) [${algo}]`,
              backtrace: javaBt(),
              extra: {
                algo,
                callId,
                offset: Number(offset),
                length: Number(length),
                outputCapacity: Number(output?.length ?? 0),
                detailType: "input",
                len: inBuf.byteLength,
              },
            } satisfies BaseMessage,
            inBuf,
          );
        }

        const written = Number(this.doFinal(input, offset, length, output));
        const outBuf = toBufferSlice(output, 0, written);
        if (outBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.doFinal",
              dir: "leave",
              line: `Cipher.doFinal(...) → wrote[${written}B] [${algo}]`,
              extra: {
                algo,
                callId,
                written,
                detailType: "output",
                len: outBuf.byteLength,
              },
            } satisfies BaseMessage,
            outBuf,
          );
        }
        return written;
      }),
    );

    // doFinal(byte[], int, int, byte[], int)
    hooks.push(
      javaHook(
        Cipher,
        "doFinal",
        ["[B", "int", "int", "[B", "int"],
        function (input, offset, length, output, outOffset) {
          const algo = this.getAlgorithm();
          const callId = nextCallId("Cipher.doFinal");
          const inBuf = toBufferSlice(input, offset, length);
          if (inBuf) {
            send(
              {
                subject: "crypto",
                category: "cipher",
                symbol: "Cipher.doFinal",
                dir: "enter",
                line: `Cipher.doFinal(input[${inBuf.byteLength}B], off=${offset}, len=${length}, out[${output?.length ?? 0}B], outOff=${outOffset}) [${algo}]`,
                backtrace: javaBt(),
                extra: {
                  algo,
                  callId,
                  offset: Number(offset),
                  length: Number(length),
                  outputCapacity: Number(output?.length ?? 0),
                  outOffset: Number(outOffset),
                  detailType: "input",
                  len: inBuf.byteLength,
                },
              } satisfies BaseMessage,
              inBuf,
            );
          }

          const written = Number(
            this.doFinal(input, offset, length, output, outOffset),
          );
          const outBuf = toBufferSlice(output, outOffset, written);
          if (outBuf) {
            send(
              {
                subject: "crypto",
                category: "cipher",
                symbol: "Cipher.doFinal",
                dir: "leave",
                line: `Cipher.doFinal(...) → wrote[${written}B @${outOffset}] [${algo}]`,
                extra: {
                  algo,
                  callId,
                  written,
                  outOffset: Number(outOffset),
                  detailType: "output",
                  len: outBuf.byteLength,
                },
              } satisfies BaseMessage,
              outBuf,
            );
          }
          return written;
        },
      ),
    );

    // update(byte[])
    hooks.push(
      javaHook(Cipher, "update", ["[B"], function (input) {
        const algo = this.getAlgorithm();
        const callId = nextCallId("Cipher.update");
        const inBuf = toBuffer(input);
        if (inBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.update",
              dir: "enter",
              line: `Cipher.update(input[${inBuf.byteLength}B]) [${algo}]`,
              backtrace: javaBt(),
              extra: {
                algo,
                callId,
                detailType: "input",
                len: inBuf.byteLength,
              },
            } satisfies BaseMessage,
            inBuf,
          );
        }
        const result = this.update(input);
        const outBuf = toBuffer(result);
        if (outBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.update",
              dir: "leave",
              line: `Cipher.update() → [${outBuf.byteLength}B] [${algo}]`,
              extra: {
                algo,
                callId,
                detailType: "output",
                len: outBuf.byteLength,
              },
            } satisfies BaseMessage,
            outBuf,
          );
        }
        return result;
      }),
    );

    // update(byte[], int, int)
    hooks.push(
      javaHook(Cipher, "update", ["[B", "int", "int"], function (
        input,
        offset,
        length,
      ) {
        const algo = this.getAlgorithm();
        const callId = nextCallId("Cipher.update");
        const inBuf = toBufferSlice(input, offset, length);
        if (inBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.update",
              dir: "enter",
              line: `Cipher.update(input[${inBuf.byteLength}B], off=${offset}, len=${length}) [${algo}]`,
              backtrace: javaBt(),
              extra: {
                algo,
                callId,
                offset: Number(offset),
                length: Number(length),
                detailType: "input",
                len: inBuf.byteLength,
              },
            } satisfies BaseMessage,
            inBuf,
          );
        }

        const result = this.update(input, offset, length);
        const outBuf = toBuffer(result);
        if (outBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.update",
              dir: "leave",
              line: `Cipher.update(...) → [${outBuf.byteLength}B] [${algo}]`,
              extra: {
                algo,
                callId,
                detailType: "output",
                len: outBuf.byteLength,
              },
            } satisfies BaseMessage,
            outBuf,
          );
        }
        return result;
      }),
    );

    // update(byte[], int, int, byte[])
    hooks.push(
      javaHook(Cipher, "update", ["[B", "int", "int", "[B"], function (
        input,
        offset,
        length,
        output,
      ) {
        const algo = this.getAlgorithm();
        const callId = nextCallId("Cipher.update");
        const inBuf = toBufferSlice(input, offset, length);
        if (inBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.update",
              dir: "enter",
              line: `Cipher.update(input[${inBuf.byteLength}B], off=${offset}, len=${length}, out[${output?.length ?? 0}B]) [${algo}]`,
              backtrace: javaBt(),
              extra: {
                algo,
                callId,
                offset: Number(offset),
                length: Number(length),
                outputCapacity: Number(output?.length ?? 0),
                detailType: "input",
                len: inBuf.byteLength,
              },
            } satisfies BaseMessage,
            inBuf,
          );
        }

        const written = Number(this.update(input, offset, length, output));
        const outBuf = toBufferSlice(output, 0, written);
        if (outBuf) {
          send(
            {
              subject: "crypto",
              category: "cipher",
              symbol: "Cipher.update",
              dir: "leave",
              line: `Cipher.update(...) → wrote[${written}B] [${algo}]`,
              extra: {
                algo,
                callId,
                written,
                detailType: "output",
                len: outBuf.byteLength,
              },
            } satisfies BaseMessage,
            outBuf,
          );
        }
        return written;
      }),
    );

    // update(byte[], int, int, byte[], int)
    hooks.push(
      javaHook(
        Cipher,
        "update",
        ["[B", "int", "int", "[B", "int"],
        function (input, offset, length, output, outOffset) {
          const algo = this.getAlgorithm();
          const callId = nextCallId("Cipher.update");
          const inBuf = toBufferSlice(input, offset, length);
          if (inBuf) {
            send(
              {
                subject: "crypto",
                category: "cipher",
                symbol: "Cipher.update",
                dir: "enter",
                line: `Cipher.update(input[${inBuf.byteLength}B], off=${offset}, len=${length}, out[${output?.length ?? 0}B], outOff=${outOffset}) [${algo}]`,
                backtrace: javaBt(),
                extra: {
                  algo,
                  callId,
                  offset: Number(offset),
                  length: Number(length),
                  outputCapacity: Number(output?.length ?? 0),
                  outOffset: Number(outOffset),
                  detailType: "input",
                  len: inBuf.byteLength,
                },
              } satisfies BaseMessage,
              inBuf,
            );
          }

          const written = Number(this.update(input, offset, length, output, outOffset));
          const outBuf = toBufferSlice(output, outOffset, written);
          if (outBuf) {
            send(
              {
                subject: "crypto",
                category: "cipher",
                symbol: "Cipher.update",
                dir: "leave",
                line: `Cipher.update(...) → wrote[${written}B @${outOffset}] [${algo}]`,
                extra: {
                  algo,
                  callId,
                  written,
                  outOffset: Number(outOffset),
                  detailType: "output",
                  len: outBuf.byteLength,
                },
              } satisfies BaseMessage,
              outBuf,
            );
          }
          return written;
        },
      ),
    );
  });

  return hooks;
}

export function pbkdf() {
  const hooks: InvocationListener[] = [];

  Java.perform(() => {
    const PBEKeySpec = Java.use("javax.crypto.spec.PBEKeySpec");
    const StringCls = Java.use("java.lang.String");

    const toStr = (arr: any) =>
      arr === null ? "(null)" : StringCls.$new(arr).toString();

    // PBEKeySpec(char[])
    hooks.push(
      javaHook(PBEKeySpec, "$init", ["[C"], function (pass) {
        const password = toStr(pass);
        send({
          subject: "crypto",
          category: "pbkdf",
          symbol: "PBEKeySpec",
          dir: "enter",
          line: `PBEKeySpec(pass="${password}")`,
          backtrace: javaBt(),
          extra: { password },
        } satisfies BaseMessage);
        this.$init(pass);
      }),
    );

    // PBEKeySpec(char[], byte[], int)
    hooks.push(
      javaHook(
        PBEKeySpec,
        "$init",
        ["[C", "[B", "int"],
        function (pass, salt, iter) {
          const password = toStr(pass);
          const saltBuf = toBuffer(salt);
          send(
            {
              subject: "crypto",
              category: "pbkdf",
              symbol: "PBEKeySpec",
              dir: "enter",
              line: `PBEKeySpec(pass="${password}", salt[${salt?.length ?? 0}B], iter=${iter})`,
              backtrace: javaBt(),
              extra: {
                password,
                iterations: iter,
                detailType: "salt",
                len: salt?.length ?? 0,
              },
            } satisfies BaseMessage,
            saltBuf,
          );
          this.$init(pass, salt, iter);
        },
      ),
    );

    // PBEKeySpec(char[], byte[], int, int)
    hooks.push(
      javaHook(
        PBEKeySpec,
        "$init",
        ["[C", "[B", "int", "int"],
        function (pass, salt, iter, keyLen) {
          const password = toStr(pass);
          const saltBuf = toBuffer(salt);
          send(
            {
              subject: "crypto",
              category: "pbkdf",
              symbol: "PBEKeySpec",
              dir: "enter",
              line: `PBEKeySpec(pass="${password}", salt[${salt?.length ?? 0}B], iter=${iter}, keyLen=${keyLen})`,
              backtrace: javaBt(),
              extra: {
                password,
                iterations: iter,
                keyLength: keyLen,
                detailType: "salt",
                len: salt?.length ?? 0,
              },
            } satisfies BaseMessage,
            saltBuf,
          );
          this.$init(pass, salt, iter, keyLen);
        },
      ),
    );
  });

  return hooks;
}

export function keygen() {
  const hooks: InvocationListener[] = [];

  Java.perform(() => {
    const Builder = Java.use(
      "android.security.keystore.KeyGenParameterSpec$Builder",
    );

    const boolMethods = [
      "setUserAuthenticationRequired",
      "setRandomizedEncryptionRequired",
      "setInvalidatedByBiometricEnrollment",
      "setUnlockedDeviceRequired",
      "setUserConfirmationRequired",
      "setUserPresenceRequired",
      "setIsStrongBoxBacked",
    ];

    const intMethods = [
      "setKeySize",
      "setUserAuthenticationValidityDurationSeconds",
    ];

    for (const name of boolMethods) {
      try {
        hooks.push(
          javaHook(Builder, name, ["boolean"], function (value) {
            send({
              subject: "crypto",
              category: "keygen",
              symbol: `KeyGenParameterSpec.${name}`,
              dir: "enter",
              line: `Builder.${name}(${value})`,
              backtrace: javaBt(),
              extra: { method: name, value: String(value) },
            } satisfies BaseMessage);
            return this[name](value);
          }),
        );
      } catch (_) {
        /* not available on this API level */
      }
    }

    for (const name of intMethods) {
      try {
        hooks.push(
          javaHook(Builder, name, ["int"], function (value) {
            send({
              subject: "crypto",
              category: "keygen",
              symbol: `KeyGenParameterSpec.${name}`,
              dir: "enter",
              line: `Builder.${name}(${value})`,
              backtrace: javaBt(),
              extra: { method: name, value: String(value) },
            } satisfies BaseMessage);
            return this[name](value);
          }),
        );
      } catch (_) {
        /* not available on this API level */
      }
    }
  });

  return hooks;
}
