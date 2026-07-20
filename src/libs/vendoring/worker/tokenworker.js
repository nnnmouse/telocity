/*
This file contains a stripped down adaptation of the
tokenizer from Huggingface's Transformers.js.
Entirely LLM refactored.

Original transformers.js work:
Copyright The Hugging Face Inc. team.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { deserialize } from "node:v8";
import { parentPort } from "node:worker_threads";

/**
 * @template K, V
 */
class FastCache {
  /**
   * @param {number} [maxSize]
   */
  constructor(maxSize = 100) {
    /** @type {number} */
    this.maxSize = maxSize;
    /** @type {Map<K, V>} */
    this.current = new Map();
    /** @type {Map<K, V>} */
    this.old = new Map();
  }

  /**
   * @param {K} key
   * @returns {V | undefined}
   */
  get(key) {
    let item = this.current.get(key);
    if (item !== undefined) return item;
    item = this.old.get(key);
    if (item !== undefined) {
      this.current.set(key, item);
      return item;
    }
    return undefined;
  }

  /**
   * @param {K} key
   * @param {V} value
   * @returns {void}
   */
  set(key, value) {
    if (this.current.has(key)) {
      this.current.set(key, value);
    } else {
      this.current.set(key, value);
      if (this.current.size >= this.maxSize) {
        this.old = this.current;
        this.current = new Map();
      }
    }
  }
}

var MAX_CACHE_LENGTH = 256;

/**
 * @param {string} str
 * @returns {number[]}
 */
function encodeUTF8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push((c >> 6) | 0xc0, (c & 0x3f) | 0x80);
    } else if (c >= 0xd800 && c < 0xe000) {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      out.push(
        (c >> 18) | 0xf0,
        ((c >> 12) & 0x3f) | 0x80,
        ((c >> 6) & 0x3f) | 0x80,
        (c & 0x3f) | 0x80,
      );
    } else {
      out.push((c >> 12) | 0xe0, ((c >> 6) & 0x3f) | 0x80, (c & 0x3f) | 0x80);
    }
  }
  return out;
}

var PROBLEMATIC_REPLACERS = [
  {
    re: /(?i:'s|'t|'re|'ve|'m|'ll|'d)/g,
    replacement:
      "(?:'s|'S|'t|'T|'re|'Re|'rE|'RE|'ve|'Ve|'vE|'VE|'m|'M|'ll|'Ll|'lL|'LL|'d|'D)",
  },
];

/**
 * @typedef {Object} PatternConfig
 * @property {string} [Regex]
 * @property {string} [String]
 */

/**
 * @param {PatternConfig | null | undefined} patternConfig
 * @param {boolean} [invert]
 * @returns {RegExp | null}
 */
function createPattern(patternConfig, invert = true) {
  if (!patternConfig) {
    return null;
  }
  if (patternConfig.Regex !== undefined) {
    let regexStr = patternConfig.Regex;
    for (const { re, replacement } of PROBLEMATIC_REPLACERS) {
      regexStr = regexStr.replace(re, replacement);
    }
    regexStr = regexStr.replace(/\(([#&~])\)/g, "(?:$1)");
    return new RegExp(regexStr, "gu");
  }
  if (patternConfig.String !== undefined) {
    return new RegExp(RegExp.escape(patternConfig.String), invert ? "gu" : "g");
  }
  return null;
}

/**
 * @param {string} text
 * @param {RegExp | null} regex
 * @returns {string[]}
 */
function regexSplit(text, regex) {
  if (!text) return [];
  if (!regex) return [text];

  /** @type {string[]} */
  const result = [];
  let lastIndex = 0;
  const re = regex.global ? regex : new RegExp(regex.source, regex.flags + "g");
  re.lastIndex = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    if (idx > lastIndex) {
      result.push(text.slice(lastIndex, idx));
    }
    const matchValue = m[0];
    if (matchValue === undefined) continue;

    if (m.length > 1) {
      for (let i = 1; i < m.length; i++) {
        const captureGroup = m[i];
        if (captureGroup !== undefined) {
          result.push(captureGroup);
        }
      }
    } else {
      result.push(matchValue);
    }
    lastIndex = idx + matchValue.length;
    if (re.lastIndex === idx) {
      re.lastIndex++;
    }
  }
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }
  return result;
}

/** @type {string[] | null} */
var _BYTES_TO_UNICODE = null;

/**
 * @returns {string[]}
 */
function getBytesToUnicode() {
  if (_BYTES_TO_UNICODE) {
    return _BYTES_TO_UNICODE;
  }
  const initialBytes = new Set([
    ...Array.from({ length: 126 - 33 + 1 }, (_, i) => i + 33),
    ...Array.from({ length: 172 - 161 + 1 }, (_, i) => i + 161),
    ...Array.from({ length: 255 - 174 + 1 }, (_, i) => i + 174),
  ]);
  const byteToChar = Array.from({ length: 256 }, () => "");
  let invisibleCharCodepoint = 256;
  for (let byte = 0; byte < 256; ++byte) {
    if (initialBytes.has(byte)) {
      byteToChar[byte] = String.fromCharCode(byte);
    } else {
      byteToChar[byte] = String.fromCharCode(invisibleCharCodepoint++);
    }
  }
  _BYTES_TO_UNICODE = byteToChar;
  return byteToChar;
}

var BYTE_AS_TOKEN_CACHE = Array.from({ length: 256 }, (_, i) => {
  return `<0x${i.toString(16).toUpperCase().padStart(2, "0")}>`;
});

/**
 * @typedef {Object} NormalizerConfig
 * @property {string} type
 * @property {PatternConfig} [pattern]
 * @property {string} [content]
 * @property {NormalizerConfig[]} [normalizers]
 */

/**
 * @param {NormalizerConfig | null | undefined} config
 * @returns {(text: string) => string}
 */
function createNormalizer(config) {
  if (!config) {
    return (text) => text;
  }
  switch (config.type) {
    case "NFC":
      return (text) => text.normalize("NFC");
    case "Replace": {
      const pattern = createPattern(config.pattern);
      const content = config.content ?? "";
      return pattern
        ? (text) =>
            String(text).replace(/** @type {RegExp} */ (pattern), content)
        : (text) => text;
    }
    case "Sequence": {
      const normalizers = config.normalizers?.map(createNormalizer) ?? [];
      return (text) => normalizers.reduce((acc, norm) => norm(acc), text);
    }
    default:
      return (text) => text;
  }
}

/**
 * @typedef {Object} PreTokenizerConfig
 * @property {string} type
 * @property {PreTokenizerConfig[]} [pretokenizers]
 * @property {PatternConfig} [pattern]
 * @property {boolean} [invert]
 * @property {string} [behavior]
 * @property {boolean} [add_prefix_space]
 * @property {boolean} [use_regex]
 * @property {string} [content]
 */

/**
 * @param {PreTokenizerConfig | null | undefined} config
 * @returns {(text: string) => string[]}
 */
function createPreTokenizer(config) {
  if (!config) {
    return (text) => (text ? [text] : []);
  }
  switch (config.type) {
    case "Sequence": {
      const preTokenizers = config.pretokenizers?.map(createPreTokenizer) ?? [];
      return (text) => {
        if (!text) return [];
        let segments = [text];
        for (let i = 0; i < preTokenizers.length; i++) {
          /** @type {string[]} */
          const nextSegments = [];
          for (let j = 0; j < segments.length; j++) {
            const currentSeg = segments[j];
            if (currentSeg === undefined) continue;
            const res = (preTokenizers[i] ?? ((t) => [t]))(currentSeg);
            for (let k = 0; k < res.length; k++) {
              const resToken = res[k];
              if (resToken !== undefined) nextSegments.push(resToken);
            }
          }
          segments = nextSegments;
        }
        return segments;
      };
    }
    case "Split": {
      const pattern = createPattern(config.pattern, config.invert);
      const behavior = config.behavior?.toLowerCase() ?? "";
      return (text) => {
        if (!text) return [];
        if (!pattern) return [text];
        if (config.invert) {
          return text.match(pattern) || [];
        }
        if (behavior === "removed") {
          return text.split(pattern).filter(Boolean);
        }
        return regexSplit(text, pattern);
      };
    }
    case "ByteLevel": {
      const { add_prefix_space = false, use_regex = true } = config;
      const pattern =
        /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
      const byteToChar = getBytesToUnicode();

      /**
       * @param {string} token
       * @returns {string}
       */
      function encodeToken(token) {
        let isAscii = true;
        for (let i = 0; i < token.length; i++) {
          if (token.charCodeAt(i) >= 128) {
            isAscii = false;
            break;
          }
        }
        if (isAscii) {
          let str = "";
          for (let i = 0; i < token.length; i++) {
            const charCode = token.charCodeAt(i);
            const unicodeChar = byteToChar[charCode];
            if (unicodeChar !== undefined) str += unicodeChar;
          }
          return str;
        }
        const bytes = encodeUTF8(token);
        let str = "";
        for (let i = 0; i < bytes.length; i++) {
          const byteVal = bytes[i];
          if (byteVal !== undefined) {
            const unicodeChar = byteToChar[byteVal];
            if (unicodeChar !== undefined) str += unicodeChar;
          }
        }
        return str;
      }

      return (text) => {
        if (text === null || text === undefined) return [];
        let processedText = String(text);
        if (add_prefix_space && !processedText.startsWith(" ")) {
          processedText = " " + processedText;
        }

        /** @type {string[]} */
        const out = [];
        if (!use_regex) {
          out.push(encodeToken(processedText));
          return out;
        }

        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(processedText)) !== null) {
          out.push(encodeToken(m[0]));
        }
        return out;
      };
    }
    case "Replace": {
      const pattern = createPattern(config.pattern);
      const content = config.content ?? "";
      return (text) =>
        text && pattern
          ? [String(text).replace(pattern, content)]
          : text
            ? [text]
            : [];
    }
    default:
      return (text) => (text ? [text] : []);
  }
}

/**
 * @typedef {Object} CompiledBpeState
 * @property {Map<string, number>} vocab
 * @property {Map<string, Map<string, number>>} merges
 * @property {string} [unk_token]
 * @property {boolean} [byte_fallback]
 * @property {string} [end_of_word_suffix]
 * @property {string} [continuing_subword_suffix]
 */

/**
 * @typedef {Object} BpeModel
 * @property {Map<string, number>} vocab
 * @property {string | undefined} unk_token_str
 * @property {(pre_tokenized_strings: string[]) => number} count
 */

/**
 * @param {CompiledBpeState} compiledState
 * @returns {BpeModel}
 */
function createBPEModelFromCompiled(compiledState) {
  const vocab = compiledState.vocab;
  const merges = compiledState.merges;
  const unk_token_str = compiledState.unk_token;
  const {
    byte_fallback = false,
    end_of_word_suffix,
    continuing_subword_suffix,
  } = compiledState;

  /** @type {FastCache<string, string[]>} */
  const bpeCache = new FastCache(5000);

  let maxN = 0;
  /** @type {Int32Array | null} */
  let prev = null;
  /** @type {Int32Array | null} */
  let next = null;
  /** @type {Uint8Array | null} */
  let alive = null;
  /** @type {Uint32Array | null} */
  let ver = null;
  /** @type {Int32Array | null} */
  let ord = null;
  /** @type {Int32Array | null} */
  let heap = null;
  const HEAP_STRIDE = 6;

  /**
   * @param {number} n
   */
  function ensureCapacity(n) {
    if (n > maxN) {
      maxN = Math.max(n, maxN * 2, 256);
      prev = new Int32Array(maxN);
      next = new Int32Array(maxN);
      alive = new Uint8Array(maxN);
      ver = new Uint32Array(maxN);
      ord = new Int32Array(maxN);
      heap = new Int32Array(maxN * HEAP_STRIDE * 4);
    }
  }

  /**
   * @param {string} token
   * @returns {string[]}
   */
  function bpe(token) {
    const cached = bpeCache.get(token);
    if (cached !== undefined) return cached;
    if (!token) return [];

    const parts = token.split("");
    if (end_of_word_suffix && parts.length > 0) {
      const lastIndex = parts.length - 1;
      const lastVal = parts[lastIndex];
      if (lastVal !== undefined) {
        parts[lastIndex] = lastVal + end_of_word_suffix;
      }
    }

    const n = parts.length;
    if (n <= 1) {
      if (token.length < MAX_CACHE_LENGTH) {
        bpeCache.set(token, parts);
      }
      return parts;
    }

    ensureCapacity(n);

    if (!prev || !next || !alive || !ver || !ord || !heap) {
      return parts;
    }

    for (let i = 0; i < n; i++) {
      prev[i] = i - 1;
      next[i] = i + 1;
      alive[i] = 1;
      ver[i] = 0;
      ord[i] = i;
    }
    next[n - 1] = -1;

    let heapSize = 0;

    /**
     * @param {number} rank
     * @param {number} ordVal
     * @param {number} l
     * @param {number} r
     * @param {number} vL
     * @param {number} vR
     */
    const heapPush = (rank, ordVal, l, r, vL, vR) => {
      if (!heap) return;
      let idx = heapSize++;
      while (idx > 0) {
        const p = (idx - 1) >>> 1;
        const pPtr = p * HEAP_STRIDE;
        const idxPtr = idx * HEAP_STRIDE;

        const pRank = heap[pPtr];
        if (pRank === undefined) break;

        const heapPtrPlusOne = heap[pPtr + 1];
        if (
          pRank < rank ||
          (pRank === rank &&
            heapPtrPlusOne !== undefined &&
            heapPtrPlusOne <= ordVal)
        ) {
          break;
        }

        for (let offset = 0; offset < HEAP_STRIDE; offset++) {
          const srcVal = heap[pPtr + offset];
          if (srcVal !== undefined) {
            heap[idxPtr + offset] = srcVal;
          }
        }

        idx = p;
      }

      const fPtr = idx * HEAP_STRIDE;
      heap[fPtr] = rank;
      heap[fPtr + 1] = ordVal;
      heap[fPtr + 2] = l;
      heap[fPtr + 3] = r;
      heap[fPtr + 4] = vL;
      heap[fPtr + 5] = vR;
    };

    /**
     * @param {{ rank: number, ord: number, l: number, r: number, vL: number, vR: number }} outObj
     * @returns {boolean}
     */
    const heapPop = (outObj) => {
      if (heapSize === 0 || !heap) return false;

      outObj.rank = heap[0] ?? 0;
      outObj.ord = heap[1] ?? 0;
      outObj.l = heap[2] ?? 0;
      outObj.r = heap[3] ?? 0;
      outObj.vL = heap[4] ?? 0;
      outObj.vR = heap[5] ?? 0;

      heapSize--;
      const lastIdx = heapSize;

      if (lastIdx > 0) {
        const lastPtr = lastIdx * HEAP_STRIDE;
        const lastRank = heap[lastPtr] ?? 0;
        const lastOrd = heap[lastPtr + 1] ?? 0;

        let idx = 0;
        const half = lastIdx >>> 1;

        while (idx < half) {
          let left = (idx << 1) + 1;
          let right = left + 1;
          let smallest = left;

          const leftPtr = left * HEAP_STRIDE;
          const rightPtr = right * HEAP_STRIDE;

          if (right < lastIdx) {
            const rRank = heap[rightPtr] ?? 0;
            const lRank = heap[leftPtr] ?? 0;
            const rightPtrPlusOne = heap[rightPtr + 1] ?? 0;
            const leftPtrPlusOne = heap[leftPtr + 1] ?? 0;
            if (
              rRank < lRank ||
              (rRank === lRank && rightPtrPlusOne < leftPtrPlusOne)
            ) {
              smallest = right;
            }
          }

          const smallPtr = smallest * HEAP_STRIDE;
          const sRank = heap[smallPtr] ?? 0;
          const smallPtrPlusOne = heap[smallPtr + 1] ?? 0;

          if (
            lastRank < sRank ||
            (lastRank === sRank && lastOrd <= smallPtrPlusOne)
          ) {
            break;
          }

          const idxPtr = idx * HEAP_STRIDE;
          for (let offset = 0; offset < HEAP_STRIDE; offset++) {
            const smallVal = heap[smallPtr + offset];
            if (smallVal !== undefined) {
              heap[idxPtr + offset] = smallVal;
            }
          }

          idx = smallest;
        }

        const fPtr = idx * HEAP_STRIDE;
        for (let offset = 0; offset < HEAP_STRIDE; offset++) {
          const lastVal = heap[lastPtr + offset];
          if (lastVal !== undefined) {
            heap[fPtr + offset] = lastVal;
          }
        }
      }
      return true;
    };

    /**
     * @param {number} l
     * @param {number} r
     * @returns {number | undefined}
     */
    const getRank = (l, r) => {
      if (l === -1 || r === -1) return undefined;
      const lPart = parts[l];
      const rPart = parts[r];
      if (lPart === undefined || rPart === undefined) return undefined;
      const p1Map = merges.get(lPart);
      if (p1Map) return p1Map.get(rPart);
      return undefined;
    };

    for (let i = 0; i < n - 1; i++) {
      const rk = getRank(i, i + 1);
      if (rk !== undefined) {
        heapPush(rk, ord[i] ?? 0, i, i + 1, ver[i] ?? 0, ver[i + 1] ?? 0);
      }
    }

    const top = { rank: 0, ord: 0, l: 0, r: 0, vL: 0, vR: 0 };

    while (heapPop(top)) {
      const { l, r, vL, vR } = top;

      if (
        !alive[l] ||
        !alive[r] ||
        ver[l] !== vL ||
        ver[r] !== vR ||
        next[l] !== r ||
        prev[r] !== l
      ) {
        continue;
      }

      const lPart = parts[l];
      const rPart = parts[r];
      if (lPart !== undefined && rPart !== undefined) {
        parts[l] = lPart + rPart;
      }

      alive[r] = 0;
      ver[l] = (ver[l] ?? 0) + 1;

      const rn = next[r] ?? -1;
      next[l] = rn;
      if (rn !== -1) {
        prev[rn] = l;
      }

      const ordR = ord[r] ?? 0;
      const ordL = ord[l] ?? 0;
      if (ordR < ordL) {
        ord[l] = ordR;
      }

      const pl = prev[l] ?? -1;
      if (pl !== -1) {
        const rk1 = getRank(pl, l);
        if (rk1 !== undefined) {
          heapPush(rk1, ord[pl] ?? 0, pl, l, ver[pl] ?? 0, ver[l] ?? 0);
        }
      }

      if (rn !== -1) {
        const rk2 = getRank(l, rn);
        if (rk2 !== undefined) {
          heapPush(rk2, ord[l] ?? 0, l, rn, ver[l] ?? 0, ver[rn] ?? 0);
        }
      }
    }

    /** @type {string[]} */
    const out = [];
    for (let i = 0; i !== -1; i = next[i] ?? -1) {
      if (alive[i]) {
        const item = parts[i];
        if (item !== undefined) out.push(item);
      }
    }

    if (continuing_subword_suffix && out.length > 1) {
      for (let i = 0; i < out.length - 1; i++) {
        const word = out[i];
        if (word !== undefined) {
          out[i] = word + continuing_subword_suffix;
        }
      }
    }

    if (token.length < MAX_CACHE_LENGTH) {
      bpeCache.set(token, out);
    }
    return out;
  }

  /**
   * @param {string[]} pre_tokenized_strings
   * @returns {number}
   */
  function count(pre_tokenized_strings) {
    let token_count = 0;
    for (const token of pre_tokenized_strings) {
      if (!token) continue;
      const parts = bpe(token);
      for (const subword of parts) {
        if (vocab.has(subword)) {
          token_count++;
          continue;
        }
        if (byte_fallback) {
          const bytes = encodeUTF8(subword);
          let all_bytes_in_vocab = true;
          for (let i = 0; i < bytes.length; i++) {
            const byteVal = bytes[i];
            if (byteVal === undefined) {
              all_bytes_in_vocab = false;
              break;
            }
            const byteToken = BYTE_AS_TOKEN_CACHE[byteVal];
            if (byteToken === undefined || !vocab.has(byteToken)) {
              all_bytes_in_vocab = false;
              break;
            }
          }
          if (all_bytes_in_vocab) {
            token_count += bytes.length;
            continue;
          }
        }
        token_count += unk_token_str ? 1 : subword.length;
      }
    }
    return token_count;
  }

  return { vocab, unk_token_str, count };
}

/**
 * @typedef {Object} TokenContent
 * @property {string} content
 */

/**
 * @param {string | TokenContent | null | undefined} configVal
 * @param {string | null} [fallback]
 * @returns {string | null}
 */
var getConfigToken = (configVal, fallback = null) => {
  if (!configVal) return fallback;
  return typeof configVal === "string"
    ? configVal
    : (configVal.content ?? fallback);
};

/**
 * @typedef {Object} AhoNode
 * @property {Object<string, number>} children
 * @property {string | null} output
 * @property {number} failure
 */

/**
 * @param {{ content: string }[] | null | undefined} patterns
 * @returns {AhoNode[] | null}
 */
function buildAhoCorasick(patterns) {
  if (!patterns || patterns.length === 0) return null;
  const sortedPatterns = [...patterns].sort(
    (a, b) => b.content.length - a.content.length,
  );
  /** @type {AhoNode} */
  const root = { children: Object.create(null), output: null, failure: 0 };
  /** @type {AhoNode[]} */
  const trie = [root];

  for (const p of sortedPatterns) {
    let node = root;
    for (let i = 0; i < p.content.length; i++) {
      const charCode = p.content.charCodeAt(i);
      const childNodeIndex = node.children[charCode];
      if (childNodeIndex === undefined) {
        const newNodeIndex = trie.length;
        /** @type {AhoNode} */
        const newNode = {
          children: Object.create(null),
          output: null,
          failure: 0,
        };
        trie.push(newNode);
        node.children[charCode] = newNodeIndex;
        node = newNode;
      } else {
        const nextNode = trie[childNodeIndex];
        if (nextNode) node = nextNode;
      }
    }
    if (!node.output) {
      node.output = p.content;
    }
  }

  /** @type {number[]} */
  const queue = [];
  for (const charCode in root.children) {
    const val = root.children[charCode];
    if (val !== undefined) queue.push(val);
  }

  let qIndex = 0;
  while (qIndex < queue.length) {
    const currentIndex = queue[qIndex++];
    if (currentIndex === undefined) continue;
    const currentNode = trie[currentIndex];
    if (!currentNode) continue;

    for (const charCode in currentNode.children) {
      const childIndex = currentNode.children[charCode];
      if (childIndex === undefined) continue;
      let failureIndex = currentNode.failure;
      while (
        failureIndex > 0 &&
        trie[failureIndex]?.children[charCode] === undefined
      ) {
        const failNode = trie[failureIndex];
        failureIndex = failNode ? failNode.failure : 0;
      }

      const failureTargetNode = trie[failureIndex];
      if (
        failureTargetNode &&
        failureTargetNode.children[charCode] !== undefined
      ) {
        const targetIdx = failureTargetNode.children[charCode];
        const childNode = trie[childIndex];
        if (childNode && targetIdx !== undefined) childNode.failure = targetIdx;
      }

      const childNode = trie[childIndex];
      if (childNode) {
        const failOutputNode = trie[childNode.failure];
        if (failOutputNode && failOutputNode.output && !childNode.output) {
          childNode.output = failOutputNode.output;
        }
      }
      queue.push(childIndex);
    }
  }
  return trie;
}

/**
 * @typedef {Object} TemplateItem
 * @property {Object} [SpecialToken]
 * @property {string} [SpecialToken.id]
 * @property {string} [SpecialToken.type]
 * @property {Object} [Sequence]
 * @property {string} [Sequence.id]
 * @property {string} [Sequence.type]
 */

/**
 * @typedef {Object} TemplateConfig
 * @property {string} type
 * @property {TemplateItem[]} [single]
 * @property {TemplateItem[]} [pair]
 */

/**
 * @typedef {Object} PostProcessorConfig
 * @property {string} type
 * @property {TemplateConfig[]} [processors]
 * @property {TemplateItem[]} [single]
 * @property {TemplateItem[]} [pair]
 */

/**
 * @typedef {Object} CompiledTokenizerState
 * @property {NormalizerConfig} [normalizer]
 * @property {PreTokenizerConfig} [pre_tokenizer]
 * @property {Map<string, number>} vocab
 * @property {Map<string, Map<string, number>>} merges
 * @property {string} [unk_token]
 * @property {boolean} [byte_fallback]
 * @property {string} [end_of_word_suffix]
 * @property {string} [continuing_subword_suffix]
 * @property {{ content: string }[]} [added_tokens]
 * @property {string | TokenContent} [bos_token]
 * @property {string | TokenContent} [eos_token]
 * @property {string | TokenContent} [sep_token]
 * @property {PostProcessorConfig} [post_processor]
 */

/**
 * @typedef {Object} Tokenizer
 * @property {(text: string | null | undefined, text_pair?: string | null, options?: { add_special_tokens?: boolean }) => number} count
 */

/**
 * @param {CompiledTokenizerState} compiledState
 * @returns {Tokenizer}
 */
function createTokenizerFromCompiledState(compiledState) {
  const normalizer = createNormalizer(compiledState.normalizer);
  const pre_tokenizer = createPreTokenizer(compiledState.pre_tokenizer);
  const model = createBPEModelFromCompiled(compiledState);
  const added_tokens = compiledState.added_tokens || [];

  const addedTokensAho = buildAhoCorasick(added_tokens);
  const added_tokens_map = new Map(added_tokens.map((at) => [at.content, at]));

  const bos_token_str = getConfigToken(compiledState.bos_token);
  const eos_token_str = getConfigToken(compiledState.eos_token);
  const sep_token_str = getConfigToken(compiledState.sep_token);

  /** @type {TemplateConfig | null} */
  let template_processor_config = null;
  const postProcessor = compiledState.post_processor;
  if (postProcessor) {
    if (postProcessor.type === "TemplateProcessing") {
      template_processor_config = /** @type {TemplateConfig} */ (
        /** @type {unknown} */ (postProcessor)
      );
    } else if (postProcessor.type === "Sequence" && postProcessor.processors) {
      const processors = postProcessor.processors;
      const found = processors.find((p) => p?.type === "TemplateProcessing");
      if (found) {
        template_processor_config = found;
      }
    }
  }

  /** @type {FastCache<string, number>} */
  const countCoreCache = new FastCache(5000);

  /**
   * @param {string | null | undefined} text_input
   * @returns {number}
   */
  function count_text_core(text_input) {
    const cached = text_input ? countCoreCache.get(text_input) : undefined;
    if (cached !== undefined) return cached;
    if (text_input === null || text_input === undefined) return 0;

    const text = String(text_input);
    if (text === "") return 0;

    let total_count = 0;
    if (!addedTokensAho) {
      const norm = normalizer(text);
      const preTok = pre_tokenizer(norm);
      if (preTok?.length > 0) {
        total_count = model ? model.count(preTok) : preTok.length;
      }
    } else {
      let lastIndex = 0;
      let currentNodeIndex = 0;
      const trie = addedTokensAho;

      for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        const currentNode = trie[currentNodeIndex];
        if (!currentNode) continue;
        let nextNodeIndex = currentNode.children[charCode];

        while (currentNodeIndex > 0 && nextNodeIndex === undefined) {
          currentNodeIndex = currentNode.failure;
          const parentNode = trie[currentNodeIndex];
          if (parentNode) {
            nextNodeIndex = parentNode.children[charCode];
          } else {
            break;
          }
        }

        if (nextNodeIndex !== undefined) {
          currentNodeIndex = nextNodeIndex;
        }

        const trieNode = trie[currentNodeIndex];
        const match = trieNode ? trieNode.output : null;
        if (match) {
          const matchLen = match.length;
          const matchStart = i - matchLen + 1;

          if (matchStart > lastIndex) {
            const segment = text.slice(lastIndex, matchStart);
            const norm = normalizer(segment);
            const preTok = pre_tokenizer(norm);
            if (preTok?.length > 0) {
              total_count += model ? model.count(preTok) : preTok.length;
            }
          }
          total_count++;
          lastIndex = i + 1;
          currentNodeIndex = 0;
        }
      }

      if (lastIndex < text.length) {
        const segment = text.slice(lastIndex);
        const norm = normalizer(segment);
        const preTok = pre_tokenizer(norm);
        if (preTok?.length > 0) {
          total_count += model ? model.count(preTok) : preTok.length;
        }
      }
    }

    if (text_input.length < MAX_CACHE_LENGTH) {
      countCoreCache.set(text_input, total_count);
    }
    return total_count;
  }

  /**
   * @param {string | null | undefined} token_str
   * @returns {boolean}
   */
  const isTokenValid = (token_str) => {
    if (!token_str) return false;
    return (
      added_tokens_map.has(token_str) ||
      (model !== null && model.vocab.has(token_str))
    );
  };

  /**
   * @param {string | null | undefined} text
   * @param {string | null | undefined} text_pair
   * @param {boolean} add_special_tokens
   * @returns {number}
   */
  function count(text, text_pair, add_special_tokens) {
    if (!model) return 0;

    const countA = count_text_core(text);
    const countB = text_pair ? count_text_core(text_pair) : 0;

    if (!add_special_tokens) {
      return countA + countB;
    }

    const template = text_pair
      ? template_processor_config?.pair
      : template_processor_config?.single;

    if (template) {
      let total_count = 0;
      for (let i = 0; i < template.length; i++) {
        const item = template[i];
        if (item && item.SpecialToken && isTokenValid(item.SpecialToken.id)) {
          total_count += 1;
        } else if (item && item.Sequence?.id === "A") {
          total_count += countA;
        } else if (item && item.Sequence?.id === "B" && text_pair) {
          total_count += countB;
        }
      }
      return total_count;
    }

    let special_token_count = 0;
    if (bos_token_str && countA > 0 && isTokenValid(bos_token_str)) {
      special_token_count++;
    }
    if (text_pair) {
      if (sep_token_str && isTokenValid(sep_token_str)) {
        special_token_count++;
      }
    }
    if (eos_token_str && countA > 0 && isTokenValid(eos_token_str)) {
      special_token_count++;
    }
    return countA + countB + special_token_count;
  }

  return {
    count: (text, text_pair = null, options = {}) => {
      const { add_special_tokens = true } = options;
      return count(text, text_pair, add_special_tokens);
    },
  };
}

/** @type {FastCache<string, Tokenizer>} */
var tokenizerCache = new FastCache(50);

/**
 * @param {string} tokenizerName
 * @param {ArrayBufferLike} sharedBinaryBuffer
 * @returns {Tokenizer}
 */
function loadTokenizer(tokenizerName, sharedBinaryBuffer) {
  let tokenizer = tokenizerCache.get(tokenizerName);
  if (tokenizer === undefined) {
    const compiledState = /** @type {CompiledTokenizerState} */ (
      deserialize(new Uint8Array(sharedBinaryBuffer))
    );
    tokenizer = createTokenizerFromCompiledState(compiledState);
    tokenizerCache.set(tokenizerName, tokenizer);
  }
  return tokenizer;
}

/**
 * @typedef {Object} WorkerInputItem
 * @property {string | null} text
 * @property {string | null} [text_pair]
 * @property {{ add_special_tokens?: boolean }} [options]
 */

/**
 * @typedef {Object} WorkerMessageData
 * @property {string} type
 * @property {number} jobId
 * @property {string} tokenizerName
 * @property {ArrayBufferLike} sharedBinaryBuffer
 * @property {WorkerInputItem[]} inputs
 */

const port = parentPort;
if (port) {
  port.on("message", (data) => {
    const msg = /** @type {WorkerMessageData} */ (data);
    const { type, jobId, tokenizerName, sharedBinaryBuffer, inputs } = msg;

    try {
      if (type === "init") {
        loadTokenizer(tokenizerName, sharedBinaryBuffer);

        port.postMessage({
          type: "ready",
          memoryUsage: process.memoryUsage().rss,
        });
        return;
      }

      if (type === "count") {
        const tokenizer = loadTokenizer(tokenizerName, sharedBinaryBuffer);
        const results = inputs.map((input) =>
          tokenizer.count(input.text, input.text_pair, input.options),
        );
        port.postMessage({
          jobId,
          results,
          memoryUsage: process.memoryUsage().rss,
        });
        return;
      }
    } catch (e) {
      const error = /** @type {Error} */ (e);
      port.postMessage({
        jobId,
        error: {
          message: error.message,
          stack: error.stack,
        },
      });
    }
  });
}

var tokenworker_default = {};
export {
  createTokenizerFromCompiledState as createTokenizer,
  tokenworker_default as default,
};
