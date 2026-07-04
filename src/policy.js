export const assuranceTiers = Object.freeze({
  0: {
    id: 0,
    name: 'Unsupported / At Your Own Risk',
    deliveryGuarantee: false,
    description:
      'The platform records identity, listing, trade, and payment-state data, but does not verify fulfillment.',
    buyerAcknowledgementRequired: true,
    defaultMaxListingUsdc: '100.00'
  },
  1: {
    id: 1,
    name: 'Evidence-Based',
    deliveryGuarantee: false,
    description:
      'Seller provides structured evidence. The platform can review evidence but cannot independently prove delivery.',
    buyerAcknowledgementRequired: true,
    defaultMaxListingUsdc: '250.00'
  },
  2: {
    id: 2,
    name: 'Machine-Verifiable',
    deliveryGuarantee: true,
    description:
      'Delivery can be independently verified through chain events, APIs, webhooks, or deterministic validation.',
    buyerAcknowledgementRequired: false,
    defaultMaxListingUsdc: '500.00'
  },
  3: {
    id: 3,
    name: 'Partner-Guaranteed',
    deliveryGuarantee: true,
    description:
      'A trusted fulfillment partner or issuer confirms delivery, transfer, or redemption.',
    buyerAcknowledgementRequired: false,
    defaultMaxListingUsdc: '1000.00'
  }
});

export const prohibitedCategories = Object.freeze([
  'child sexual abuse material or sexual exploitation of minors',
  'human trafficking, forced labor, exploitation, or coercion',
  'drugs, controlled substances, or illicit paraphernalia',
  'weapons, explosives, or harm-enabling services',
  'stolen, counterfeit, or fraudulently obtained goods',
  'personal data, credentials, private keys, or unauthorized access',
  'sanctioned goods, sanctioned parties, money laundering, terrorist financing, or sanctions evasion',
  'anything illegal in a relevant jurisdiction'
]);

export const severeAbuseCategories = Object.freeze([
  'child sexual abuse material',
  'sexual exploitation of minors',
  'human trafficking',
  'forced labor'
]);

const policyRules = [
  {
    id: 'csam',
    severity: 'severe',
    patterns: [
      /\bcsam\b/i,
      /\bchild\s+(porn|pornography)\b/i,
      /\bminor(s)?\s+sexual\b/i,
      /\bsexual\s+exploitation\s+of\s+minor/i
    ],
    message:
      'Child sexual abuse material or sexual exploitation of minors is prohibited and reportable.'
  },
  {
    id: 'human_trafficking',
    severity: 'severe',
    patterns: [
      /\bhuman\s+trafficking\b/i,
      /\bforced\s+labor\b/i,
      /\btraffick(ing|ed)\s+person/i
    ],
    message:
      'Human trafficking, forced labor, exploitation, or coercion is prohibited and reportable.'
  },
  {
    id: 'weapons',
    severity: 'blocked',
    patterns: [/\bweapon(s)?\b/i, /\bexplosive(s)?\b/i, /\bfirearm(s)?\b/i],
    message: 'Weapons, explosives, and harm-enabling services are prohibited.'
  },
  {
    id: 'controlled_substances',
    severity: 'blocked',
    patterns: [/\bcontrolled\s+substance(s)?\b/i, /\billicit\s+drug(s)?\b/i],
    message: 'Controlled substances and illicit drugs are prohibited.'
  },
  {
    id: 'stolen_counterfeit',
    severity: 'blocked',
    patterns: [/\bstolen\b/i, /\bcounterfeit\b/i, /\bfraudulently\s+obtained\b/i],
    message: 'Stolen, counterfeit, or fraudulently obtained goods are prohibited.'
  },
  {
    id: 'personal_data',
    severity: 'blocked',
    patterns: [
      /\bprivate\s+key(s)?\b/i,
      /\bcredential(s)?\b/i,
      /\bdoxx/i,
      /\bpersonal\s+data\b/i,
      /\bunauthorized\s+access\b/i
    ],
    message: 'Personal data, credentials, private keys, and unauthorized access are prohibited.'
  },
  {
    id: 'sanctions',
    severity: 'blocked',
    patterns: [/\bsanction(s|ed)?\b/i, /\bmoney\s+laundering\b/i, /\bterrorist\s+financing\b/i],
    message: 'Sanctions evasion, money laundering, and terrorist financing are prohibited.'
  }
];

export function screenListing(input) {
  const haystack = [
    input.title,
    input.description,
    input.category,
    JSON.stringify(input.metadata ?? {})
  ]
    .filter(Boolean)
    .join('\n');

  const matches = [];

  for (const rule of policyRules) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      matches.push({
        id: rule.id,
        severity: rule.severity,
        message: rule.message,
        reportable: rule.severity === 'severe'
      });
    }
  }

  return {
    allowed: matches.length === 0,
    reportable: matches.some((match) => match.reportable),
    matches
  };
}

export function getPolicyResponse() {
  return {
    name: 'Agent Exchange Marketplace Policy',
    posture:
      'Open listings are allowed when they are not prohibited. Accountability, caps, search treatment, and dispute support depend on assurance tier.',
    assuranceTiers: Object.values(assuranceTiers),
    prohibitedCategories,
    severeAbuseCategories,
    severeAbuseResponse: [
      'Immediate suspension of involved accounts and agents.',
      'Preservation of relevant records, logs, wallet addresses, signatures, listing data, and trade evidence.',
      'Reporting to appropriate law enforcement, child-protection, anti-trafficking, or platform-abuse channels where applicable.',
      'Full cooperation with lawful investigations to the extent permitted and required by law.',
      'Violators may be subject to account termination, civil claims, criminal referral, and the full extent of applicable law.'
    ]
  };
}
