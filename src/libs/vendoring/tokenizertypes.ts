export interface TokenizerJSON {
  version?: string;
  truncation?: unknown;
  padding?: unknown;
  decoder?: unknown;
  normalizer: NormalizerConfig | null;
  pre_tokenizer: PreTokenizerConfig | null;
  model: BPEModelConfig;
  added_tokens: AddedToken[];
  post_processor: PostProcessorConfig | null;
}
export interface TokenizerConfig {
  bos_token?: string | { content: string };
  eos_token?: string | { content: string };
  sep_token?: string | { content: string };
  version: string;
  special_tokens?: Record<string, string>;
  [key: string]: unknown;
}
export type NormalizerConfig =
  | { type: "NFC" }
  | { type: "NFKC" }
  | { type: "NFD" }
  | { type: "NFKD" }
  | { type: "Lowercase" }
  | { type: "StripAccents" }
  | { type: "BertNormalizer"; lowercase?: boolean }
  | { type: "Precompiled" }
  | { type: "Replace"; pattern: PatternConfig; content: string }
  | { type: "Sequence"; normalizers?: NormalizerConfig[] };
export type PreTokenizerConfig =
  | { type: "Sequence"; pretokenizers?: PreTokenizerConfig[] }
  | { type: "Split"; pattern: PatternConfig; behavior: string; invert: boolean }
  | { type: "ByteLevel"; add_prefix_space?: boolean; use_regex?: boolean }
  | { type: "Whitespace" }
  | { type: "Metaspace"; replacement?: string; add_prefix_space?: boolean }
  | { type: "BertPreTokenizer" }
  | { type: "Precompiled" }
  | { type: "Replace"; pattern: PatternConfig; content: string };
export interface PatternConfig {
  Regex?: string;
  String?: string;
}
export interface BPEModelConfig {
  type: "BPE";
  vocab: Record<string, number>;
  merges?: Array<string | [string, string]>;
  unk_token?: string | null;
  byte_fallback?: boolean;
  end_of_word_suffix?: string;
  continuing_subword_suffix?: string;
}
export interface AddedToken {
  id: number;
  content: string;
  special: boolean;
  single_word: boolean;
  lstrip: boolean;
  rstrip: boolean;
  normalized: boolean;
}
export interface TemplateProcessingConfig {
  type: "TemplateProcessing";
  single?: TemplateItem[];
  pair?: TemplateItem[];
}
export interface BertProcessingConfig {
  type: "BertProcessing";
  sep: [string, number];
  cls: [string, number];
}
export interface RobertaProcessingConfig {
  type: "RobertaProcessing";
  sep: [string, number];
  cls: [string, number];
  trim_offsets?: boolean;
  add_prefix_space?: boolean;
}
export type PostProcessorItem =
  | TemplateProcessingConfig
  | BertProcessingConfig
  | RobertaProcessingConfig
  | { type: "Sequence"; processors: PostProcessorItem[] };
export type PostProcessorConfig = PostProcessorItem | null;

export interface TemplateItem {
  SpecialToken?: { id: string };
  Sequence?: { id: "A" | "B" };
}
export interface Tokenizer {
  count: (
    text: string,
    text_pair?: string | null,
    options?: { add_special_tokens?: boolean },
  ) => number;
}
