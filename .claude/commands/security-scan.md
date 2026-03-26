---
allowed-tools: Bash(find:*), Bash(wc:*), Bash(git log:*), Bash(cat:*), Bash(ls:*), Bash(basename:*), Bash(git:*), Read, Glob, Grep, Task, Write
description: Perform a full codebase security audit and generate a findings report
---

You are a senior security engineer conducting a comprehensive security audit of an entire codebase.

## PHASE 1 - DISCOVERY & SCOPING

First, auto-detect the project type by examining the repository structure.

**Project root:** `$ARGUMENTS` (use current directory if empty)

### Token Tracking

Throughout the entire scan, you MUST track token usage. Every time a Task sub-agent returns a result, its response includes a `<usage>` block with `total_tokens`. Record the token count from each sub-agent. Also track your own usage across phases. At the end, sum all token counts to produce a total for the report.

Initialize a running total: `total_tokens_used = 0`

### Detect Repository Name

Determine the repository name for use in report filenames:

1. Run: `git rev-parse --show-toplevel` to get the repo root path (fall back to `pwd` if not in a git repo)
2. Run: `basename <result>` on the path from step 1

Store the result as `REPO_NAME` for use in the report filename.

Run these discovery steps:

1. **Detect project type(s)** by checking for these config files:

| Config File | Language/Platform |
|---|---|
| `package.json`, `tsconfig.json` | JavaScript/TypeScript (Node.js, Frontend) |
| `build.gradle`, `build.gradle.kts`, `settings.gradle` | Java/Kotlin (Android or Backend) |
| `AndroidManifest.xml` | Android Mobile |
| `go.mod`, `go.sum` | Go (Backend) |
| `Cargo.toml` | Rust |
| `requirements.txt`, `pyproject.toml`, `setup.py` | Python |
| `Podfile`, `*.xcodeproj`, `Package.swift` | Swift/Objective-C (iOS) |
| `*.sol`, `hardhat.config.*`, `truffle-config.*`, `foundry.toml` | Solidity (Smart Contracts) |
| `pom.xml` | Java (Maven Backend) |
| `Gemfile` | Ruby |
| `composer.json` | PHP |
| `CMakeLists.txt`, `Makefile` | C/C++ |

Use `Glob` to check for these files. Also scan file extensions to determine primary languages:

```
!`find . -type f \( -name "*.java" -o -name "*.kt" -o -name "*.go" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.swift" -o -name "*.m" -o -name "*.sol" -o -name "*.py" -o -name "*.rs" -o -name "*.rb" -o -name "*.php" -o -name "*.c" -o -name "*.cpp" \) -not -path "*/node_modules/*" -not -path "*/build/*" -not -path "*/.gradle/*" -not -path "*/vendor/*" -not -path "*/target/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/Pods/*" -not -path "*/generated/*" -not -path "*/.next/*" -not -path "*/out/*" 2>/dev/null | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20`
```

2. **Enumerate source directories** (exclude build artifacts, dependencies, generated code, and test files):

```
!`find . -type d \( -name "node_modules" -o -name "build" -o -name ".gradle" -o -name "vendor" -o -name "target" -o -name ".git" -o -name "dist" -o -name "Pods" -o -name "generated" -o -name ".next" -o -name "out" -o -name "__pycache__" -o -name ".idea" -o -name ".vscode" -o -name "artifacts" -o -name "cache" -o -name "typechain-types" \) -prune -o -type d -print | head -100`
```

3. **Count scannable files:**

```
!`find . -type f \( -name "*.java" -o -name "*.kt" -o -name "*.go" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.swift" -o -name "*.m" -o -name "*.sol" -o -name "*.py" -o -name "*.rs" -o -name "*.rb" -o -name "*.php" -o -name "*.c" -o -name "*.cpp" -o -name "*.gradle" -o -name "*.kts" -o -name "*.xml" -o -name "*.yaml" -o -name "*.yml" -o -name "*.json" -o -name "*.toml" -o -name "*.properties" \) -not -path "*/node_modules/*" -not -path "*/build/*" -not -path "*/.gradle/*" -not -path "*/vendor/*" -not -path "*/target/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/Pods/*" -not -path "*/generated/*" -not -path "*/.next/*" -not -path "*/out/*" -not -path "*/test/*" -not -path "*/tests/*" -not -path "*Test.java" -not -path "*_test.go" -not -path "*.test.ts" -not -path "*.test.js" -not -path "*.spec.ts" -not -path "*.spec.js" 2>/dev/null | wc -l`
```

4. **Partition into scan chunks.** Group files by top-level module/directory. Each chunk should be a logical module or directory subtree. Aim for 5-15 chunks depending on project size.

Print a summary of what was detected:
- Project type (e.g., "Android/Java/Kotlin mobile app", "Go backend service", "TypeScript/React frontend", "Solidity smart contracts", etc.)
- Number of modules/chunks identified
- Total files to scan
- Platform category: **Backend**, **Frontend**, **Mobile (Android)**, **Mobile (iOS)**, **Smart Contract**, **Library**, **CLI Tool**, or **Full-Stack**

---

## PHASE 2 - PARALLEL SECURITY SCANNING

Spawn **one Task sub-agent per module/chunk** to scan in parallel. Each sub-agent must receive the following prompt (fill in the chunk-specific file list):

---

### SUB-AGENT PROMPT TEMPLATE

> You are a senior security engineer performing a deep security audit of a code module.
>
> **Project type:** [detected type from Phase 1]
> **Platform:** [detected platform from Phase 1]
> **Your assigned scope:** [list of files or directory glob for this chunk]
>
> Read every file in your assigned scope using the Read tool. For each file, trace data flows from inputs to sensitive operations.
>
> OBJECTIVE:
> Identify HIGH-CONFIDENCE security vulnerabilities with real exploitation potential. This is a security audit - focus ONLY on security implications. Do not comment on code style, performance, or maintainability.
>
> CRITICAL INSTRUCTIONS:
> 1. MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of actual exploitability
> 2. AVOID NOISE: Skip theoretical issues, style concerns, or low-impact findings
> 3. FOCUS ON IMPACT: Prioritize vulnerabilities that could lead to unauthorized access, data breaches, fund theft, or system compromise
> 4. EXCLUSIONS: Do NOT report DOS, rate limiting, or resource exhaustion issues
>
> SECURITY CATEGORIES TO EXAMINE:
>
> **Input Validation Vulnerabilities:**
> - SQL injection via unsanitized user input
> - Command injection in system calls or subprocesses
> - XXE injection in XML parsing
> - Template injection in templating engines
> - NoSQL injection in database queries
> - Path traversal in file operations
>
> **Authentication & Authorization Issues:**
> - Authentication bypass logic
> - Privilege escalation paths
> - Session management flaws
> - JWT token vulnerabilities
> - Authorization logic bypasses
>
> **Crypto & Secrets Management:**
> - Hardcoded API keys, passwords, or tokens
> - Weak cryptographic algorithms or implementations (ECB mode, weak KDFs, short keys)
> - Improper key storage or management
> - Cryptographic randomness issues (use of Math.random, java.util.Random for security)
> - Certificate validation bypasses (TrustAllCerts, disabled hostname verification)
>
> **Injection & Code Execution:**
> - Remote code execution via deserialization
> - Pickle/YAML/XML deserialization vulnerabilities
> - Eval injection in dynamic code execution
> - XSS vulnerabilities in web applications (reflected, stored, DOM-based)
> - WebView JavaScript bridge injection (mobile)
> - Intent injection / deep link hijacking (Android)
> - URL scheme hijacking (iOS)
>
> **Data Exposure:**
> - Sensitive data logging (keys, passwords, PII, mnemonics, private keys)
> - API endpoint data leakage
> - Debug information exposure in production builds
> - Insecure data storage (SharedPreferences, UserDefaults, localStorage for secrets)
> - Clipboard data leakage of sensitive values
>
> **PLATFORM-SPECIFIC CHECKS:**
>
> *Android/Java/Kotlin:*
> - Exported components without permission checks (activities, services, receivers, providers)
> - WebView with JavaScript enabled + addJavascriptInterface on API < 17
> - Insecure network security config (cleartext traffic, custom trust anchors)
> - Content provider path traversal
> - Pending intent mutable flags
> - Insecure broadcast receivers
> - ProGuard/R8 disabled for release builds
> - Hardcoded signing credentials
>
> *iOS/Swift/Objective-C:*
> - Insecure Keychain access (kSecAttrAccessibleAlways)
> - ATS (App Transport Security) exceptions
> - UIWebView usage (deprecated, insecure)
> - Pasteboard data leakage
> - Jailbreak detection bypass
> - Insecure URL scheme handlers
>
> *Go Backend:*
> - Unsafe use of `unsafe` package
> - Goroutine leaks in security-critical paths
> - Missing TLS configuration
> - SQL injection via string concatenation (not using parameterized queries)
> - SSRF via unvalidated URLs (host/protocol control)
>
> *TypeScript/JavaScript (Frontend & Node.js):*
> - dangerouslySetInnerHTML / bypassSecurityTrustHtml usage
> - Prototype pollution
> - Server-side request forgery
> - Insecure use of eval, Function constructor, vm module
> - Missing CSRF protection on state-changing endpoints
> - Insecure cookie configuration (missing httpOnly, secure, sameSite)
> - npm/yarn supply chain risks in dependency configuration
>
> *Solidity/Smart Contracts:*
> - Reentrancy vulnerabilities (external calls before state changes)
> - Integer overflow/underflow (pre-Solidity 0.8)
> - Unchecked external call return values (low-level call, send, delegatecall)
> - Access control issues (missing onlyOwner, unprotected selfdestruct)
> - Front-running vulnerabilities (MEV, sandwich attacks)
> - Flash loan attack vectors
> - Oracle manipulation
> - Signature replay / missing nonce
> - tx.origin authentication (instead of msg.sender)
> - Delegatecall to untrusted contracts
> - Storage collision in proxy patterns
> - Denial of service via gas limits in loops
> - Insecure randomness (block.timestamp, blockhash as entropy)
> - Uninitialized storage pointers
> - ERC-20/721/1155 compliance issues with security impact
>
> ANALYSIS METHODOLOGY:
>
> Phase A - Context Research:
> - Identify existing security frameworks and libraries in use
> - Look for established secure coding patterns in the codebase
> - Examine existing sanitization and validation patterns
> - Understand the project's security model and threat model
>
> Phase B - File-by-File Analysis:
> - Read each file in your assigned scope
> - Trace data flow from user inputs to sensitive operations
> - Look for privilege boundaries being crossed unsafely
> - Identify injection points and unsafe deserialization
> - Check for hardcoded secrets and weak crypto
>
> Phase C - Cross-File Analysis:
> - Trace data flows across file boundaries within your scope
> - Identify inconsistent security implementations
> - Flag code that introduces new attack surfaces
>
> FALSE POSITIVE FILTERING:
>
> HARD EXCLUSIONS - Automatically exclude findings matching these patterns:
> 1. Denial of Service (DOS) vulnerabilities or resource exhaustion attacks
> 2. Secrets or credentials stored on disk if they are otherwise secured (e.g., encrypted keystores with proper access control)
> 3. Rate limiting concerns or service overload scenarios
> 4. Memory consumption or CPU exhaustion issues
> 5. Lack of input validation on non-security-critical fields without proven security impact
> 6. Input sanitization concerns for CI/CD workflows unless clearly triggerable via untrusted input
> 7. A lack of hardening measures - only flag concrete vulnerabilities, not missing best practices
> 8. Race conditions or timing attacks that are theoretical rather than practical
> 9. Vulnerabilities related to outdated third-party libraries (managed separately)
> 10. Memory safety issues in memory-safe languages (Rust, Go, Java, Kotlin, Swift)
> 11. Files that are only unit tests or only used as part of running tests
> 12. Log spoofing concerns (unsanitized user input in logs is not a vulnerability unless it exposes PII/secrets)
> 13. SSRF vulnerabilities that only control the path (only report if attacker controls host or protocol)
> 14. Including user-controlled content in AI system prompts is not a vulnerability
> 15. Regex injection or Regex DOS concerns
> 16. Insecure documentation - do not report findings in markdown, README, or doc files
> 17. A lack of audit logs is not a vulnerability
> 18. Environment variables and CLI flags are trusted values
> 19. Resource management issues such as memory or file descriptor leaks
>
> PRECEDENTS:
> 1. Logging high-value secrets in plaintext IS a vulnerability. Logging URLs is assumed safe.
> 2. UUIDs can be assumed unguessable and do not need validation.
> 3. React and Angular are generally secure against XSS - do not report XSS unless using dangerouslySetInnerHTML, bypassSecurityTrustHtml, or similar unsafe methods.
> 4. Client-side JS/TS code does not need permission checking or authentication - that's the server's responsibility.
> 5. Only include MEDIUM findings if they are obvious and concrete issues.
> 6. Command injection in shell scripts is generally not exploitable unless there is a specific attack path with untrusted input.
> 7. For smart contracts, do NOT report gas optimization issues, missing events, or code style concerns.
>
> SEVERITY GUIDELINES:
> - **HIGH**: Directly exploitable vulnerabilities leading to RCE, data breach, authentication bypass, or fund theft
> - **MEDIUM**: Vulnerabilities requiring specific conditions but with significant impact
> - **LOW**: Defense-in-depth issues or lower-impact vulnerabilities
>
> CONFIDENCE SCORING:
> - 0.9-1.0: Certain exploit path identified
> - 0.8-0.9: Clear vulnerability pattern with known exploitation methods
> - 0.7-0.8: Suspicious pattern requiring specific conditions to exploit
> - Below 0.7: Don't report (too speculative)
>
> OUTPUT FORMAT:
> Return your findings as a JSON array. Each finding must have these fields:
> ```json
> {
>   "id": "CHUNK-N",
>   "category": "category_name",
>   "severity": "HIGH|MEDIUM|LOW",
>   "confidence": 0.9,
>   "file": "path/to/file.ext",
>   "line": 42,
>   "title": "Short title",
>   "description": "Detailed description of the vulnerability",
>   "exploit_scenario": "How an attacker could exploit this",
>   "recommendation": "How to fix it"
> }
> ```
>
> If you find NO vulnerabilities in your scope, return: `[]`
>
> Do NOT use the Bash tool or write to any files. Only use Read, Glob, and Grep tools to examine the code.

---

### Launching Sub-Agents

For each chunk identified in Phase 1, launch a Task sub-agent with `subagent_type: "general-purpose"` and the above prompt customized with:
- The detected project type and platform
- The specific file list or directory scope for that chunk

Launch all sub-agents in parallel (multiple Task tool calls in a single response).

### Token Tracking for Sub-Agents

After each sub-agent completes, extract the `total_tokens` value from the `<usage>` block in its response. Add this to your running `total_tokens_used` counter. Keep a per-phase breakdown:
- `phase2_scan_tokens`: Sum of all scanning sub-agent tokens
- `phase3_validation_tokens`: Sum of all validation sub-agent tokens (tracked in Phase 3)

---

## PHASE 3 - AGGREGATION & REPORTING

After all sub-agents complete:

1. **Collect** all findings from all sub-agents
2. **Filter** out any findings with confidence < 0.7
3. **Validate** each HIGH finding: spawn a parallel Task sub-agent per HIGH finding to verify it is not a false positive. The validation sub-agent should:
   - Read the specific file and surrounding context
   - Apply all FALSE POSITIVE FILTERING rules listed above
   - Assign a final confidence score (1-10 scale, where 8+ means confirmed)
   - Return either `CONFIRMED` or `FALSE_POSITIVE` with reasoning
4. **Remove** any findings where the validation sub-agent returned `FALSE_POSITIVE` or confidence < 8
5. **Deduplicate** findings that describe the same root issue
6. **Sort** by severity: HIGH > MEDIUM > LOW, then by confidence descending

### Generate Reports

Generate TWO report files in a `security-report/` subdirectory within the project root. Create the directory if it doesn't exist.

Use the `REPO_NAME` detected in Phase 1 and the current date for filenames:
- **Markdown:** `security-report/SECURITY_SCAN_REPORT_<REPO_NAME>_<YYYY-MM-DD>.md`
- **JSON:** `security-report/SECURITY_SCAN_REPORT_<REPO_NAME>_<YYYY-MM-DD>.json`

For example, if the repo is named `my-app` and the date is `2026-02-26`:
- `security-report/SECURITY_SCAN_REPORT_my-app_2026-02-26.md`
- `security-report/SECURITY_SCAN_REPORT_my-app_2026-02-26.json`

#### Markdown Report

Write the Markdown report using this format:

```markdown
# Security Scan Report

| Field | Value |
|-------|-------|
| **Project** | <project name from directory> |
| **Type** | <detected project type and platform> |
| **Date** | <current date> |
| **Files Scanned** | <count> |
| **Modules Scanned** | <count of chunks> |
| **Findings** | X HIGH, Y MEDIUM, Z LOW |

---

## Executive Summary

<2-3 sentence overview of the security posture and most critical findings>

---

## HIGH Severity

### [H1] <Category>: `file:line`

| Field | Detail |
|-------|--------|
| **Severity** | HIGH |
| **Confidence** | 0.X |
| **Category** | category_name |

**Description:** ...

**Exploit Scenario:** ...

**Recommendation:** ...

---

### [H2] ...

## MEDIUM Severity

### [M1] ...

## LOW Severity

### [L1] ...

---

## Scan Metadata

- **Scan method:** Claude Code /security-scan (full codebase audit)
- **Chunks scanned:** <list of module names>
- **False positive filtering:** Applied (confidence >= 0.7 threshold, HIGH findings independently validated)

## Token Usage

| Phase | Tokens |
|-------|--------|
| Phase 2 - Security Scanning | <phase2_scan_tokens> |
| Phase 3 - Validation | <phase3_validation_tokens> |
| Orchestration (Phase 1 + 3) | <estimated orchestration tokens> |
| **Total** | **<total_tokens_used>** |
```

#### JSON Report

Write the JSON report with this structure:

```json
{
  "report_metadata": {
    "project": "<project name>",
    "repo_name": "<REPO_NAME>",
    "type": "<detected project type and platform>",
    "date": "<YYYY-MM-DD>",
    "files_scanned": <count>,
    "modules_scanned": <count>,
    "scan_method": "Claude Code /security-scan (full codebase audit)",
    "chunks": ["<module1>", "<module2>", "..."],
    "false_positive_filtering": "Applied (confidence >= 0.7 threshold, HIGH findings independently validated)"
  },
  "summary": {
    "total_findings": <count>,
    "high": <count>,
    "medium": <count>,
    "low": <count>,
    "executive_summary": "<2-3 sentence overview>"
  },
  "findings": [
    {
      "id": "<H1|M1|L1 etc.>",
      "category": "<category_name>",
      "severity": "HIGH|MEDIUM|LOW",
      "confidence": 0.9,
      "file": "<path/to/file.ext>",
      "line": 42,
      "title": "<short title>",
      "description": "<detailed description>",
      "exploit_scenario": "<how an attacker could exploit this>",
      "recommendation": "<how to fix it>"
    }
  ],
  "token_usage": {
    "phase2_scan_tokens": <count>,
    "phase3_validation_tokens": <count>,
    "orchestration_tokens": <estimated>,
    "total_tokens": <total>
  }
}
```

### Final Output

After writing both report files:
1. Print a concise summary to the user showing the finding counts by severity
2. List the top 3 most critical findings with file locations
3. Print token usage summary (total tokens used across all phases)
4. Note both report file paths:
   - `security-report/SECURITY_SCAN_REPORT_<REPO_NAME>_<YYYY-MM-DD>.md`
   - `security-report/SECURITY_SCAN_REPORT_<REPO_NAME>_<YYYY-MM-DD>.json`
