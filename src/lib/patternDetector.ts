/**
 * IRIS Pattern Detector
 *
 * Smart entity detection that recognizes what you're looking at
 * before you even know what to do with it.
 *
 * "She sees patterns in the chaos."
 */

// ============================================================================
// Types
// ============================================================================

export interface Detection {
  type: string;
  subtype?: string;
  confidence: number;
  match: string;
  metadata: Record<string, unknown>;
}

export interface AnalysisResult {
  type: string;
  subtype?: string;
  confidence: number;
  match: string;
  metadata: Record<string, unknown>;
  allDetections: Detection[];
  suggestedActions: string[];
}

// ============================================================================
// Pattern Definitions
// ============================================================================

const PATTERNS = {
  // ═══════════════════════════════════════════════════════════════════════════
  // ENTERPRISE (keeping for compatibility)
  // ═══════════════════════════════════════════════════════════════════════════

  servicenow: {
    incident: /\bINC\d{7,10}\b/i,
    request: /\bREQ\d{7,10}\b/i,
    requestItem: /\bRITM\d{7,10}\b/i,
    change: /\bCHG\d{7,10}\b/i,
    problem: /\bPRB\d{7,10}\b/i,
    task: /\bTASK\d{7,10}\b/i,
    kb: /\bKB\d{7,10}\b/i,
  },

  jira: /\b[A-Z]{2,10}-\d{1,6}\b/,

  salesforce: /\b(?:001|003|005|006|00Q|00T|500|701)[a-zA-Z0-9]{15}\b/,

  // ═══════════════════════════════════════════════════════════════════════════
  // COMMUNICATION
  // ═══════════════════════════════════════════════════════════════════════════

  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,

  phone: {
    us: /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/,
    international: /\+[1-9]\d{1,14}\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WEB & SOCIAL
  // ═══════════════════════════════════════════════════════════════════════════

  url: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/i,

  social: {
    handle: /@[A-Za-z0-9_]{1,30}\b/,
    hashtag: /#[A-Za-z0-9_]{1,50}\b/,
    discord: /\b[A-Za-z0-9_]{2,32}#\d{4}\b/,
    reddit: /\b(?:u|r)\/[A-Za-z0-9_-]+\b/,
    youtube: {
      video: /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([A-Za-z0-9_-]{11})/,
      channel: /(?:youtube\.com\/(?:c\/|channel\/|@))([A-Za-z0-9_-]+)/,
    },
    twitch: /(?:twitch\.tv\/)([A-Za-z0-9_]+)/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SHIPPING & TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  tracking: {
    ups: /\b1Z[A-Z0-9]{16}\b/i,
    fedex: {
      express: /\b\d{12}\b/,
      ground: /\b\d{15}\b/,
      smartpost: /\b\d{20,22}\b/,
    },
    usps: /\b(?:94|93|92|94|95)\d{18,22}\b/,
    amazon: /\bTBA\d{9,12}\b/i,
    dhl: /\b\d{10,11}\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TRAVEL
  // ═══════════════════════════════════════════════════════════════════════════

  travel: {
    flight: /\b(?:AA|UA|DL|WN|AS|B6|NK|F9|G4|HA|SY|VX|AF|BA|LH|EK|QR|SQ|CX|JL|NH|QF|AC|AM|AV|CM|LA|TP|IB|AZ|KL|SK|LX|OS|TK|EY|WS|VS)[- ]?\d{1,4}\b/i,
    airport: /\b[A-Z]{3}\b/, // Will need context - many false positives
    coordinates: /[-+]?\d{1,3}\.\d{4,},\s*[-+]?\d{1,3}\.\d{4,}/,
    latLong: /(?:lat(?:itude)?[:\s]+)?[-+]?\d{1,2}\.\d+[,\s]+(?:lo?ng?(?:itude)?[:\s]+)?[-+]?\d{1,3}\.\d+/i,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CRYPTO
  // ═══════════════════════════════════════════════════════════════════════════

  crypto: {
    bitcoin: {
      legacy: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/,
      segwit: /\bbc1[a-zA-HJ-NP-Z0-9]{39,59}\b/,
    },
    ethereum: /\b0x[a-fA-F0-9]{40}\b/,
    solana: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/, // Base58
    txHash: /\b0x[a-fA-F0-9]{64}\b/, // ETH transaction
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TECH / DEV
  // ═══════════════════════════════════════════════════════════════════════════

  tech: {
    uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    macAddress: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/,
    ipv4: /\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/,
    ipv6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/,
    cidr: /\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/,
    port: /\b(?::\d{1,5})\b/,
    semver: /\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?\b/,
    dockerImage: /\b[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?\b/,
    gitBranch: /\b(?:feature|bugfix|hotfix|release|develop|main|master)\/[a-zA-Z0-9._-]+\b/,
    gitCommit: /\b[a-f0-9]{40}\b/,
    gitCommitShort: /\b[a-f0-9]{7,8}\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NETWORK / SMART HOME
  // ═══════════════════════════════════════════════════════════════════════════

  network: {
    localIp: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3})\b/,
    mdns: /\b[a-zA-Z0-9-]+\.local\b/,
    hostname: /\b[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CODE / DEV
  // ═══════════════════════════════════════════════════════════════════════════

  code: {
    function: /(?:function|def|const|let|var|async|fn|func)\s+\w+/,
    error: /(?:error|exception|failed|traceback|stack trace|panic|fatal)/i,
    filePath: {
      windows: /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/,
      unix: /(?:\/[\w.-]+)+\/?/,
    },
    json: /^\s*[\[{]/,
    sql: /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.*\b(?:FROM|INTO|TABLE|SET|WHERE)\b/i,
    regex: /\/(?:[^/\\]|\\.)+\/[gimsuy]*/,
    hexColor: /#(?:[0-9a-fA-F]{3}){1,2}\b/,
    rgbColor: /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)/i,
    base64: /\b(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY (Detect & Warn!)
  // ═══════════════════════════════════════════════════════════════════════════

  sensitive: {
    awsKey: /\bAKIA[0-9A-Z]{16}\b/,
    awsSecret: /\b[A-Za-z0-9/+=]{40}\b/, // needs context
    openaiKey: /\bsk-[A-Za-z0-9]{48}\b/,
    anthropicKey: /\bsk-ant-[A-Za-z0-9-]{95}\b/,
    githubToken: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
    genericApiKey: /\b(?:api[_-]?key|apikey|access[_-]?token)["\s:=]+["']?([A-Za-z0-9_-]{20,})["']?/i,
    privateKey: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    ssn: /\b\d{3}-\d{2}-\d{4}\b/,
    creditCard: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIME & DATE
  // ═══════════════════════════════════════════════════════════════════════════

  datetime: {
    date: /\b(?:\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\b/,
    dateWritten: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
    time: /\b(?:1[0-2]|0?[1-9]):[0-5][0-9](?::[0-5][0-9])?\s*(?:AM|PM)\b/i,
    time24: /\b(?:2[0-3]|[01]?[0-9]):[0-5][0-9](?::[0-5][0-9])?\b/,
    iso8601: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/,
    timezone: /\b(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[A-Z]{2,4}[+-]\d{1,2})\b/,
    duration: /\b\d+\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?)\b/i,
    cron: /\b(?:\*|[0-9,\-\/]+)\s+(?:\*|[0-9,\-\/]+)\s+(?:\*|[0-9,\-\/]+)\s+(?:\*|[0-9,\-\/]+)\s+(?:\*|[0-9,\-\/]+)\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MONEY & COMMERCE
  // ═══════════════════════════════════════════════════════════════════════════

  money: {
    usd: /\$[\d,]+(?:\.\d{2})?/,
    eur: /€[\d,]+(?:\.\d{2})?/,
    gbp: /£[\d,]+(?:\.\d{2})?/,
    generic: /\b\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|EUR|GBP|JPY|CNY|CAD|AUD|CHF|INR|BTC|ETH)\b/i,
    percent: /\b\d+(?:\.\d+)?%\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // IDENTIFIERS & REFERENCES
  // ═══════════════════════════════════════════════════════════════════════════

  identifiers: {
    isbn10: /\b(?:ISBN[- ]?)?(?:\d[- ]?){9}[\dXx]\b/,
    isbn13: /\b(?:ISBN[- ]?)?(?:97[89][- ]?)?(?:\d[- ]?){10}\b/,
    asin: /\bB0[A-Z0-9]{8}\b/,
    vin: /\b[A-HJ-NPR-Z0-9]{17}\b/,
    licensePlate: /\b[A-Z0-9]{1,3}[- ]?[A-Z0-9]{1,4}[- ]?[A-Z0-9]{1,4}\b/, // varies by region
    orderNumber: /\b(?:order|invoice|ref|confirmation)[#:\s]*[A-Z0-9-]{6,20}\b/i,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PEOPLE & PLACES
  // ═══════════════════════════════════════════════════════════════════════════

  person: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/,

  address: {
    us: /\b\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl)\.?(?:\s+(?:Apt|Suite|Unit|#)\s*\d+)?\b/i,
    zipcode: /\b\d{5}(?:-\d{4})?\b/,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MEASUREMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  measurement: {
    length: /\b\d+(?:\.\d+)?\s*(?:mm|cm|m|km|in|ft|yd|mi|inches|feet|yards|miles|meters|kilometers)\b/i,
    weight: /\b\d+(?:\.\d+)?\s*(?:mg|g|kg|oz|lb|lbs|pounds|grams|kilograms|ounces)\b/i,
    volume: /\b\d+(?:\.\d+)?\s*(?:ml|l|L|gal|qt|pt|fl\s*oz|liters?|gallons?)\b/i,
    temperature: /\b-?\d+(?:\.\d+)?\s*°?\s*[CF]\b/i,
    data: /\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|PB|bytes?|kilobytes?|megabytes?|gigabytes?|terabytes?)\b/i,
  },
};

// ============================================================================
// Suggested Actions by Type
// ============================================================================

const ACTIONS: Record<string, string[]> = {
  email: ['Compose email', 'Copy address', 'Search contacts', 'Add to contacts'],
  phone: ['Call', 'Text', 'Copy number', 'Add to contacts'],
  url: ['Open link', 'Copy URL', 'Preview', 'Archive to Wayback'],
  tracking: ['Track package', 'Copy number', 'Set delivery alert'],
  flight: ['Check status', 'Track flight', 'View on FlightAware'],
  coordinates: ['Open in Maps', 'Copy coordinates', 'Get directions'],
  crypto: ['View on explorer', 'Copy address', 'Check balance'],
  uuid: ['Copy', 'Format', 'Validate'],
  macAddress: ['Lookup vendor', 'Copy', 'Find on network'],
  ipv4: ['Ping', 'Lookup location', 'Open in browser', 'Scan ports'],
  localIp: ['Open in browser', 'Ping', 'SSH', 'View device'],
  mdns: ['Resolve', 'Open in browser', 'Ping'],
  gitCommit: ['View commit', 'Copy hash', 'Cherry-pick'],
  semver: ['Compare versions', 'Copy'],
  hexColor: ['Preview color', 'Copy', 'Convert to RGB'],
  sensitive: ['⚠️ SENSITIVE - Mask', 'Copy securely', 'Report exposure'],
  date: ['Add to calendar', 'Calculate days until', 'Convert timezone'],
  time: ['Convert timezone', 'Set reminder'],
  money: ['Convert currency', 'Calculate'],
  person: ['Search contacts', 'Search LinkedIn', 'Search email'],
  address: ['Open in Maps', 'Get directions', 'Copy'],
  code: ['Copy', 'Format', 'Explain'],
  error: ['Search Stack Overflow', 'Search docs', 'Copy'],
  social: ['Open profile', 'Copy handle'],
  isbn: ['Search book', 'Open on Amazon', 'Open on Goodreads'],
  asin: ['Open on Amazon'],
  servicenow: ['Open ticket', 'Copy ID'],
  jira: ['Open issue', 'Copy key'],
  default: ['Copy', 'Search'],
};

// ============================================================================
// Main Analyzer
// ============================================================================

export const PatternDetector = {
  /**
   * Analyze text and detect all patterns
   */
  analyze(text: string): AnalysisResult {
    if (!text || typeof text !== 'string') {
      return {
        type: 'unknown',
        confidence: 0,
        match: '',
        metadata: {},
        allDetections: [],
        suggestedActions: ['Copy'],
      };
    }

    const trimmed = text.trim();
    const detections: Detection[] = [];

    // ═══════════════════════════════════════════════════════════════════════
    // SECURITY FIRST - Check for sensitive data
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'sensitive', PATTERNS.sensitive, detections, 0.95, true);

    // ═══════════════════════════════════════════════════════════════════════
    // ENTERPRISE
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'servicenow', PATTERNS.servicenow, detections, 0.95);
    this.detectSingle(trimmed, 'jira', PATTERNS.jira, detections, 0.9);
    this.detectSingle(trimmed, 'salesforce', PATTERNS.salesforce, detections, 0.85);

    // ═══════════════════════════════════════════════════════════════════════
    // COMMUNICATION
    // ═══════════════════════════════════════════════════════════════════════

    this.detectSingle(trimmed, 'email', PATTERNS.email, detections, 0.95);
    this.detectPatterns(trimmed, 'phone', PATTERNS.phone, detections, 0.9);

    // ═══════════════════════════════════════════════════════════════════════
    // WEB & SOCIAL
    // ═══════════════════════════════════════════════════════════════════════

    this.detectSingle(trimmed, 'url', PATTERNS.url, detections, 0.95);
    this.detectPatterns(trimmed, 'social', PATTERNS.social, detections, 0.85);

    // ═══════════════════════════════════════════════════════════════════════
    // SHIPPING
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'tracking', PATTERNS.tracking, detections, 0.9);

    // ═══════════════════════════════════════════════════════════════════════
    // TRAVEL
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'travel', PATTERNS.travel, detections, 0.8);

    // ═══════════════════════════════════════════════════════════════════════
    // CRYPTO
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'crypto', PATTERNS.crypto, detections, 0.85);

    // ═══════════════════════════════════════════════════════════════════════
    // TECH
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'tech', PATTERNS.tech, detections, 0.85);

    // ═══════════════════════════════════════════════════════════════════════
    // NETWORK / SMART HOME
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'network', PATTERNS.network, detections, 0.9);

    // ═══════════════════════════════════════════════════════════════════════
    // CODE
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'code', PATTERNS.code, detections, 0.75);

    // ═══════════════════════════════════════════════════════════════════════
    // DATE/TIME
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'datetime', PATTERNS.datetime, detections, 0.85);

    // ═══════════════════════════════════════════════════════════════════════
    // MONEY
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'money', PATTERNS.money, detections, 0.9);

    // ═══════════════════════════════════════════════════════════════════════
    // IDENTIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'identifiers', PATTERNS.identifiers, detections, 0.8);

    // ═══════════════════════════════════════════════════════════════════════
    // PEOPLE & PLACES
    // ═══════════════════════════════════════════════════════════════════════

    this.detectSingle(trimmed, 'person', PATTERNS.person, detections, 0.5);
    this.detectPatterns(trimmed, 'address', PATTERNS.address, detections, 0.75);

    // ═══════════════════════════════════════════════════════════════════════
    // MEASUREMENTS
    // ═══════════════════════════════════════════════════════════════════════

    this.detectPatterns(trimmed, 'measurement', PATTERNS.measurement, detections, 0.85);

    // Sort by confidence
    detections.sort((a, b) => b.confidence - a.confidence);

    if (detections.length > 0) {
      const best = detections[0];
      const actionKey = best.subtype || best.type;
      return {
        type: best.type,
        subtype: best.subtype,
        confidence: best.confidence,
        match: best.match,
        metadata: best.metadata,
        allDetections: detections,
        suggestedActions: ACTIONS[actionKey] || ACTIONS[best.type] || ACTIONS.default,
      };
    }

    return {
      type: 'text',
      confidence: 0.1,
      match: trimmed,
      metadata: {
        length: trimmed.length,
        wordCount: trimmed.split(/\s+/).length,
      },
      allDetections: [],
      suggestedActions: ['Copy', 'Search'],
    };
  },

  /**
   * Detect single pattern
   */
  detectSingle(
    text: string,
    type: string,
    pattern: RegExp,
    detections: Detection[],
    confidence: number
  ): void {
    const match = text.match(pattern);
    if (match) {
      detections.push({
        type,
        confidence,
        match: match[0],
        metadata: this.extractMetadata(type, match[0], text),
      });
    }
  },

  /**
   * Detect nested patterns (object with multiple subpatterns)
   */
  detectPatterns(
    text: string,
    type: string,
    patterns: Record<string, RegExp | Record<string, RegExp>>,
    detections: Detection[],
    baseConfidence: number,
    isSensitive = false
  ): void {
    for (const [subtype, pattern] of Object.entries(patterns)) {
      if (pattern instanceof RegExp) {
        const match = text.match(pattern);
        if (match) {
          detections.push({
            type: isSensitive ? 'sensitive' : type,
            subtype,
            confidence: baseConfidence,
            match: isSensitive ? this.mask(match[0]) : match[0],
            metadata: {
              ...this.extractMetadata(subtype, match[0], text),
              isSensitive,
              originalLength: match[0].length,
            },
          });
        }
      } else {
        // Nested object (e.g., social.youtube.video)
        for (const [nestedType, nestedPattern] of Object.entries(pattern)) {
          const match = text.match(nestedPattern);
          if (match) {
            detections.push({
              type,
              subtype: `${subtype}.${nestedType}`,
              confidence: baseConfidence,
              match: match[0],
              metadata: this.extractMetadata(`${subtype}.${nestedType}`, match[0], text),
            });
          }
        }
      }
    }
  },

  /**
   * Extract type-specific metadata
   */
  extractMetadata(type: string, match: string, _fullText?: string): Record<string, unknown> {
    switch (type) {
      case 'email': {
        const [local, domain] = match.split('@');
        return { email: match, local, domain, isPersonal: this.isPersonalEmail(domain) };
      }
      case 'url': {
        try {
          const url = new URL(match);
          return { url: match, domain: url.hostname, protocol: url.protocol, path: url.pathname };
        } catch {
          return { url: match };
        }
      }
      case 'phone':
      case 'us':
      case 'international':
        return { number: match.replace(/\D/g, ''), formatted: match };
      case 'tracking':
      case 'ups':
      case 'fedex':
      case 'usps':
      case 'amazon':
        return { trackingNumber: match, carrier: this.guessCarrier(match) };
      case 'flight':
        return { flightNumber: match, airline: match.replace(/\d/g, '').trim() };
      case 'coordinates':
      case 'latLong': {
        const coords = match.match(/-?\d+\.\d+/g);
        return { lat: coords?.[0], lng: coords?.[1], raw: match };
      }
      case 'bitcoin':
      case 'ethereum':
      case 'solana':
        return { address: match, network: type };
      case 'hexColor':
        return { hex: match, rgb: this.hexToRgb(match) };
      case 'semver':
        return { version: match, parts: match.replace(/^v/, '').split('.') };
      case 'date':
      case 'dateWritten':
      case 'iso8601':
        return { dateString: match, parsed: this.tryParseDate(match) };
      case 'usd':
      case 'eur':
      case 'gbp':
      case 'generic':
        return { amount: this.parseMoneyValue(match), raw: match };
      case 'awsKey':
      case 'openaiKey':
      case 'anthropicKey':
      case 'githubToken':
      case 'ssn':
      case 'creditCard':
        return { type, warning: '⚠️ SENSITIVE DATA DETECTED' };
      default:
        return { value: match };
    }
  },

  /**
   * Mask sensitive data
   */
  mask(value: string): string {
    if (value.length <= 8) return '••••••••';
    return value.slice(0, 4) + '•'.repeat(value.length - 8) + value.slice(-4);
  },

  /**
   * Check if email is personal (gmail, outlook, etc)
   */
  isPersonalEmail(domain: string): boolean {
    const personal = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'protonmail.com'];
    return personal.some(p => domain.toLowerCase().includes(p));
  },

  /**
   * Guess shipping carrier from tracking number format
   */
  guessCarrier(tracking: string): string {
    if (/^1Z/i.test(tracking)) return 'UPS';
    if (/^TBA/i.test(tracking)) return 'Amazon';
    if (/^9[234]/.test(tracking)) return 'USPS';
    if (/^\d{12}$/.test(tracking)) return 'FedEx';
    if (/^\d{15}$/.test(tracking)) return 'FedEx Ground';
    return 'Unknown';
  },

  /**
   * Convert hex color to RGB
   */
  hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    } : null;
  },

  /**
   * Try to parse a date string
   */
  tryParseDate(dateStr: string): string | null {
    try {
      const date = new Date(dateStr);
      return isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
      return null;
    }
  },

  /**
   * Parse money value to number
   */
  parseMoneyValue(str: string): number {
    const cleaned = str.replace(/[^0-9.]/g, '');
    return parseFloat(cleaned) || 0;
  },

  /**
   * Quick check if text likely contains a specific type
   */
  quickCheck(text: string, type: keyof typeof PATTERNS): boolean {
    const pattern = PATTERNS[type];
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    return Object.values(pattern).some(p =>
      p instanceof RegExp ? p.test(text) : Object.values(p as Record<string, RegExp>).some(np => np.test(text))
    );
  },
};

export default PatternDetector;
