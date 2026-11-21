Do not emit code yet. Enter plan mode.

[TASK REQUEST HERE]

---

# Developer Instructions & Quality Guidelines

To ensure compatibility with this project, you must adhere strictly to the following architectural, type safety, and linting standards.

### 1. Workflow & Safety Checks

- **Plan Mode & Architectural Challenge First:** Provide a high-level architectural plan of the modifications before writing any actual code implementations.
  - **Crucially:** Do not accept a requested design blindly. If the proposed plan is overly complex, introduces redundant logic, or violates clean separation of concerns (e.g., putting global integration rules into specific strategy leaf-classes instead of the base orchestration layer), stop and propose a simpler, cleaner alternative.
  - Compare the trade-offs of different structural options (e.g., config-level variables vs. tuple overrides) before finalizing the path.
- **Context Check:** If a file that must be modified or referenced is missing from the chat history, **do not attempt to generate placeholder code or guess its structure**. Stop immediately and request that the missing file's contents be provided.

### 2. TypeScript & Type Safety (Strict Mode)

- **No Unsafe Types:** The use of the `any` type is strictly prohibited. Use explicit types, type unions, or `unknown` where appropriate.
- **Centralized vs. Local Types:**
  - Define local interfaces or inline types when a type is strictly scoped to a single function, class, or file.
  - If a type is used in multiple locations, define or import it from the centralized type files in `src/libs/types/`.
  - You are encouraged to improve or modernize existing central types to make them more robust and idiomatic.
- **Static Class Field Completeness:**
  - Every option or parameter resolved dynamically (e.g., via `resolveConfig`, `Object.assign`, or options parsing) **must** be statically declared on the target class or interfaces. Do not rely on dynamic property assignment without its corresponding static property declaration.
  - Ensure that type changes are fully synchronized. If a type is updated in `LLMConfigurableProps` or `types.ts`, immediately trace and update the concrete class properties (`LLM`, `LLMJSONLBatcher`, etc.) to prevent static compilation errors.
- **Type Safety Idioms:** Leverage generics, type guards, and precise narrowing where possible.
- **Type Casting Limits:** Use type assertion/casting (`as Type`) only as a last resort, such as parsing untyped payload boundaries (e.g., `JSON.parse` results).
- **TypeScript Rule Compliance:** Adhere to these strict static analysis and resolution rules, specifically:
  - `noUncheckedIndexedAccess` (safely check for `undefined` when using dynamic indices).
  - `noPropertyAccessFromIndexSignature` (use bracket notation for index signatures).

### 3. Codebase Idioms & Utility Usage

- **String Formatting:** Do not construct dynamic strings manually if they can be templated. Utilize the built-in `simpleTemplate(template, data)` function from the core library.
- **Global State:** Access the application state globally and cleanly using the package's idiomatic `x.a` or `x.appState` context patterns.

### 4. Internationalization (i18n)

- **No Hardcoded User Strings:** Do not inline raw, user-facing error messages, prompts, or UI labels directly into the TS files.
- **Virtual Reference:** Within your proposed code, assume the required translation keys already exist under the `appState.s` translation map.
- **Translation Appendix:** At the end of your response, output a clean JSON block containing the new translations. **Crucially, you must preserve the full, deeply nested object hierarchy** (e.g., `{"e": {"v": {"newKey": "Value"}}}`). Do not output flattened keys or dot-notation strings. The output must be a valid structural partial of the base `data/i18n/en-US.json` file so it can be directly deep-merged.

### 5. Template Variable Syntax

- **Strict Dot Prefix:** All dynamic template variables within user-facing strings, error messages, and i18n JSON files must use the dot-prefixed Go-style template syntax: `{{ .VariableName }}` (e.g., `{{ .Line }}`, `{{ .CustomId }}`, `{{ .Tokens }}`).
- **Do Not Omit the Dot:** Do not output standard mustache/handlebars syntax like `{{ VariableName }}`. The internal `simpleTemplate` utility matches variables strictly against the pattern `/\{\{\s*\.\s*(\w+)\s*\}\}/g`, so omitting the dot will prevent parameter substitution from working.
