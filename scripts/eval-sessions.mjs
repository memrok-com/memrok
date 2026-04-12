#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../packages/store/dist/index.js';
import { createInjector } from '../packages/injector/dist/index.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but', 'not',
  'this', 'that', 'it', 'be', 'as', 'do', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'shall',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her',
  'its', 'our', 'their', 'what', 'which', 'who', 'when', 'where', 'how',
]);

const DOMAIN_KEYWORDS = {
  memrok: new Set(['memrok', 'injector', 'reflection', 'scribe', 'clawhub']),
  priomind: new Set(['priomind', 'tweet', 'tweets', 'linkedin', 'pricing', 'customer', 'landing']),
  zhaw: new Set(['zhaw', 'art', 'architecture', 'confluence', 'jira', 'evento']),
  fcl: new Set(['fcl', 'spielleiter', 'ifv', 'refsix', 'match', 'matches']),
  orbitals: new Set(['orbitals', 'episode', 'script', 'scene', 'character', 'pilot']),
  infra: new Set(['infra', 'infrastructure', 'gateway', 'cron', 'telegram', 'provider', 'openclaw']),
  health: new Set(['health', 'wellbeing', 'sleep', 'sick', 'energy']),
  learning: new Set(['learning', 'learn', 'study', 'reading', 'course']),
};

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );
}

function countKeywordOverlap(tokens, keywords) {
  let matches = 0;
  for (const token of tokens) {
    if (keywords.has(token)) matches++;
  }
  return matches;
}

function detectDomainFocus(queryKeywords) {
  let bestDomain = null;
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = countKeywordOverlap(queryKeywords, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestScore >= 2 ? bestDomain : null;
}

function parseArgs(argv) {
  const options = {
    sessionsDir: '/home/michael/.openclaw/agents/main/sessions',
    dbPath: process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db',
    tokenBudget: 1000,
    recentMessageLimit: 12,
    asJson: false,
    compare: true,
    noPersist: false,
    includeHeaders: false,
    outputPath: null,
    allSessions: false,
    recentSessions: null,
    sessionIds: [],
    topics: [],
    channels: [],
    providers: [],
    labelPatterns: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db' && argv[i + 1]) options.dbPath = argv[++i];
    else if (arg === '--sessions' && argv[i + 1]) options.sessionsDir = argv[++i];
    else if (arg === '--budget' && argv[i + 1]) options.tokenBudget = Number(argv[++i]);
    else if (arg === '--recent-limit' && argv[i + 1]) options.recentMessageLimit = Number(argv[++i]);
    else if (arg === '--json') options.asJson = true;
    else if (arg === '--no-compare') options.compare = false;
    else if (arg === '--dry-run' || arg === '--no-persist') options.noPersist = true;
    else if (arg === '--headers' || arg === '--full-header') options.includeHeaders = true;
    else if (arg === '--out' && argv[i + 1]) options.outputPath = argv[++i];
    else if (arg === '--all-sessions') options.allSessions = true;
    else if (arg === '--recent-sessions' && argv[i + 1]) options.recentSessions = Number(argv[++i]);
    else if (arg === '--session-id' && argv[i + 1]) options.sessionIds.push(argv[++i]);
    else if (arg === '--topic' && argv[i + 1]) options.topics.push(String(argv[++i]));
    else if (arg === '--channel' && argv[i + 1]) options.channels.push(argv[++i]);
    else if (arg === '--provider' && argv[i + 1]) options.providers.push(argv[++i]);
    else if (arg === '--label' && argv[i + 1]) options.labelPatterns.push(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.tokenBudget) || options.tokenBudget <= 0) {
    throw new Error(`Invalid --budget value: ${options.tokenBudget}`);
  }
  if (!Number.isFinite(options.recentMessageLimit) || options.recentMessageLimit <= 0) {
    throw new Error(`Invalid --recent-limit value: ${options.recentMessageLimit}`);
  }
  if (options.recentSessions !== null && (!Number.isFinite(options.recentSessions) || options.recentSessions <= 0)) {
    throw new Error(`Invalid --recent-sessions value: ${options.recentSessions}`);
  }

  return options;
}

function isLiveSessionFilename(fileName) {
  if (!fileName.endsWith('.jsonl')) return false;
  if (fileName.includes('.reset.') || fileName.includes('.deleted.')) return false;
  if (fileName.includes('.tmp') || fileName.includes('.lock')) return false;
  return true;
}

function parseSessionFilename(fileName) {
  const baseName = path.basename(fileName);
  const topicMatch = baseName.match(/^(.*?)(?:-topic-([^.]+))?\.jsonl$/);
  if (!topicMatch) {
    return { sessionId: baseName.replace(/\.jsonl$/, ''), topic: null };
  }
  return {
    sessionId: topicMatch[1],
    topic: topicMatch[2] ?? null,
  };
}

function loadSessionIndex(sessionsDir) {
  const indexPath = path.join(sessionsDir, 'sessions.json');
  if (!fs.existsSync(indexPath)) return new Map();

  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map();

  const index = new Map();
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== 'object') continue;
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : null;
    if (!sessionId) continue;
    index.set(sessionId, value);
  }
  return index;
}

function extractRecentMessages(filePath, limit) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) {
    return { recentMessages: '', sessionRow: null };
  }

  const lines = content.split('\n');
  let sessionRow = null;
  const texts = [];

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (!sessionRow && row?.type === 'session') {
        sessionRow = row;
      }
      if (row?.type !== 'message') continue;
      const msg = row.message;
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const contentText = Array.isArray(msg.content)
        ? msg.content.map((part) => part?.text || '').join('\n')
        : typeof msg.content === 'string' ? msg.content : '';
      if (contentText.trim()) texts.push(`${msg.role}: ${contentText.trim()}`);
    } catch {}
  }

  return {
    recentMessages: texts.slice(-limit).join('\n'),
    sessionRow,
  };
}

function deriveMetadata(sessionId, filePath, stat, indexEntry, sessionRow) {
  const fileName = path.basename(filePath);
  const parsedName = parseSessionFilename(fileName);
  const indexTopic = indexEntry?.lastThreadId ?? indexEntry?.origin?.threadId ?? null;

  return {
    sessionId,
    fileName,
    filePath,
    updatedAt: indexEntry?.updatedAt ? new Date(indexEntry.updatedAt).toISOString() : new Date(stat.mtimeMs).toISOString(),
    createdAt: sessionRow?.timestamp ?? new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    label:
      indexEntry?.label ??
      indexEntry?.displayName ??
      indexEntry?.subject ??
      indexEntry?.origin?.label ??
      null,
    channel: indexEntry?.channel ?? indexEntry?.lastChannel ?? indexEntry?.origin?.surface ?? null,
    provider: indexEntry?.origin?.provider ?? null,
    topic: indexTopic === null || indexTopic === undefined ? parsedName.topic : String(indexTopic),
  };
}

function compileLabelMatcher(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

function discoverSessions(sessionsDir) {
  const sessionIndex = loadSessionIndex(sessionsDir);
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isLiveSessionFilename(entry.name)) continue;

    const filePath = path.join(sessionsDir, entry.name);
    const stat = fs.statSync(filePath);
    const parsedName = parseSessionFilename(entry.name);
    const extracted = extractRecentMessages(filePath, 12);
    const sessionId = extracted.sessionRow?.id ?? parsedName.sessionId;
    const indexEntry = sessionIndex.get(sessionId) ?? null;
    const metadata = deriveMetadata(sessionId, filePath, stat, indexEntry, extracted.sessionRow);

    sessions.push({
      ...metadata,
      statMtimeMs: stat.mtimeMs,
    });
  }

  return sessions.sort((a, b) => {
    const left = Date.parse(a.updatedAt) || a.statMtimeMs;
    const right = Date.parse(b.updatedAt) || b.statMtimeMs;
    return right - left;
  });
}

function filterSessions(sessions, options) {
  let filtered = sessions;

  if (options.sessionIds.length > 0) {
    const wanted = new Set(options.sessionIds);
    filtered = filtered.filter((session) => wanted.has(session.sessionId));
  }
  if (options.topics.length > 0) {
    const wanted = new Set(options.topics.map(String));
    filtered = filtered.filter((session) => session.topic !== null && wanted.has(String(session.topic)));
  }
  if (options.channels.length > 0) {
    const wanted = new Set(options.channels.map((value) => value.toLowerCase()));
    filtered = filtered.filter((session) => session.channel && wanted.has(session.channel.toLowerCase()));
  }
  if (options.providers.length > 0) {
    const wanted = new Set(options.providers.map((value) => value.toLowerCase()));
    filtered = filtered.filter((session) => session.provider && wanted.has(session.provider.toLowerCase()));
  }
  if (options.labelPatterns.length > 0) {
    const matchers = options.labelPatterns.map(compileLabelMatcher);
    filtered = filtered.filter((session) => {
      const label = session.label ?? '';
      return matchers.every((matcher) => matcher.test(label));
    });
  }

  if (options.allSessions) return filtered;
  if (options.recentSessions !== null) return filtered.slice(0, options.recentSessions);
  if (options.sessionIds.length > 0) return filtered;
  return filtered.slice(0, 10);
}

function summarizeSession(session, header, recentMessages) {
  const queryKeywords = tokenize(recentMessages);
  const domainFocus = detectDomainFocus(queryKeywords);
  const debugNodes = header.debugNodes ?? [];
  const selectedKeys = debugNodes.map((node) => node.key);
  const selectedDomains = {};
  const familyCounts = {};
  const categoryCounts = {};
  const attributionCounts = {};
  let relevantHits = 0;
  let outOfContextCount = 0;
  let crossDomainBleedCount = 0;

  for (const node of debugNodes) {
    if ((node.semanticScore ?? 0) >= 0.3 || (node.queryCoverage ?? 0) >= 0.2 || node.domainMatch === true) {
      relevantHits++;
    }
    if ((node.outOfContextRisk ?? 0) >= 0.5) {
      outOfContextCount++;
    }
    if (domainFocus && node.domain && node.domain !== domainFocus && (node.queryCoverage ?? 0) < 0.18) {
      crossDomainBleedCount++;
    }

    categoryCounts[node.category] = (categoryCounts[node.category] || 0) + 1;
    familyCounts[node.family] = (familyCounts[node.family] || 0) + 1;
    selectedDomains[node.domain ?? 'none'] = (selectedDomains[node.domain ?? 'none'] || 0) + 1;
    for (const reason of node.selectedBecause ?? []) {
      attributionCounts[reason] = (attributionCounts[reason] || 0) + 1;
    }
  }

  const familyEntries = Object.entries(familyCounts).sort((a, b) => b[1] - a[1]);
  const dominantFamily = familyEntries[0] ?? [null, 0];
  const relevanceHitRate = debugNodes.length === 0 ? 0 : relevantHits / debugNodes.length;

  return {
    sessionId: session.sessionId,
    fileName: session.fileName,
    filePath: session.filePath,
    label: session.label,
    channel: session.channel,
    provider: session.provider,
    topic: session.topic,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    recentMessages,
    headerText: header.text,
    tokens: header.tokens,
    nodesUsed: header.nodesUsed,
    layers: header.layers,
    domainFocus,
    relevanceHitRate,
    outOfContextCount,
    outOfContextRate: debugNodes.length === 0 ? 0 : outOfContextCount / debugNodes.length,
    crossDomainBleedCount,
    dominantFamily: {
      family: dominantFamily[0],
      count: dominantFamily[1],
      share: debugNodes.length === 0 ? 0 : dominantFamily[1] / debugNodes.length,
    },
    categories: categoryCounts,
    selectedDomains,
    attributionCounts,
    topNodes: debugNodes.slice(0, 8).map((node) => ({
      key: node.key,
      layer: node.layer,
      category: node.category,
      score: Number(node.score.toFixed(3)),
      rawScore: Number(node.rawScore.toFixed(3)),
      semanticScore: Number(node.semanticScore.toFixed(3)),
      queryCoverage: Number(node.queryCoverage.toFixed(3)),
      outOfContextRisk: Number(node.outOfContextRisk.toFixed(3)),
      domain: node.domain,
      family: node.family,
      selectedBecause: node.selectedBecause,
      value: node.value,
    })),
    selectedKeys,
  };
}

function compareSessions(sessionSummaries) {
  const comparisons = [];
  for (let i = 0; i < sessionSummaries.length; i++) {
    for (let j = i + 1; j < sessionSummaries.length; j++) {
      const left = sessionSummaries[i];
      const right = sessionSummaries[j];
      const leftKeys = new Set(left.selectedKeys);
      const rightKeys = new Set(right.selectedKeys);
      let overlap = 0;
      for (const key of leftKeys) {
        if (rightKeys.has(key)) overlap++;
      }
      const union = new Set([...leftKeys, ...rightKeys]).size;
      comparisons.push({
        leftSessionId: left.sessionId,
        rightSessionId: right.sessionId,
        overlapCount: overlap,
        overlapRate: union === 0 ? 0 : overlap / union,
      });
    }
  }
  return comparisons.sort((a, b) => b.overlapRate - a.overlapRate);
}

function emit(text, outputPath) {
  if (outputPath) {
    fs.writeFileSync(outputPath, text);
    return;
  }
  process.stdout.write(text);
}

const options = parseArgs(process.argv.slice(2));
const discoveredSessions = discoverSessions(options.sessionsDir);
const selectedSessions = filterSessions(discoveredSessions, options);

const store = createStore(options.dbPath);
const injector = createInjector(store, { tokenBudget: options.tokenBudget });
const sessionSummaries = [];

for (const session of selectedSessions) {
  const { recentMessages } = extractRecentMessages(session.filePath, options.recentMessageLimit);
  const header = injector.assemble({ recentMessages, noPersist: options.noPersist });
  sessionSummaries.push(summarizeSession(session, header, recentMessages));
}

const output = {
  dbPath: options.dbPath,
  sessionsDir: options.sessionsDir,
  tokenBudget: options.tokenBudget,
  recentMessageLimit: options.recentMessageLimit,
  noPersist: options.noPersist,
  selection: {
    allSessions: options.allSessions,
    recentSessions: options.recentSessions,
    sessionIds: options.sessionIds,
    filters: {
      topics: options.topics,
      channels: options.channels,
      providers: options.providers,
      labelPatterns: options.labelPatterns,
    },
  },
  discoveredSessionCount: discoveredSessions.length,
  selectedSessionCount: sessionSummaries.length,
  sessions: sessionSummaries,
  comparisons: options.compare ? compareSessions(sessionSummaries) : [],
};

if (options.asJson) {
  emit(`${JSON.stringify(output, null, 2)}\n`, options.outputPath);
  store.close();
  process.exit(0);
}

const lines = [];
lines.push('## Memrok Session Eval');
lines.push(`dbPath: ${options.dbPath}`);
lines.push(`sessionsDir: ${options.sessionsDir}`);
lines.push(`tokenBudget: ${options.tokenBudget}`);
lines.push(`recentMessageLimit: ${options.recentMessageLimit}`);
lines.push(`noPersist: ${options.noPersist}`);
lines.push(`discoveredSessions: ${discoveredSessions.length}`);
lines.push(`selectedSessions: ${sessionSummaries.length}`);

for (const session of sessionSummaries) {
  lines.push(`\n## Session ${session.sessionId}`);
  lines.push(`file: ${session.fileName}`);
  lines.push(`label: ${session.label ?? 'none'}`);
  lines.push(`channel: ${session.channel ?? 'none'}`);
  lines.push(`provider: ${session.provider ?? 'none'}`);
  lines.push(`topic: ${session.topic ?? 'none'}`);
  lines.push(`updatedAt: ${session.updatedAt}`);
  lines.push(`tokens=${session.tokens} nodesUsed=${session.nodesUsed}`);
  lines.push(
    `relevanceHitRate=${session.relevanceHitRate.toFixed(2)} outOfContext=${session.outOfContextCount} ` +
    `bleed=${session.crossDomainBleedCount} dominantFamily=${session.dominantFamily.family ?? 'none'}:${session.dominantFamily.count} ` +
    `share=${session.dominantFamily.share.toFixed(2)}`
  );
  lines.push(`domains=${JSON.stringify(session.selectedDomains)}`);
  lines.push(`categories=${JSON.stringify(session.categories)}`);
  lines.push(`attribution=${JSON.stringify(session.attributionCounts)}`);
  lines.push('top nodes:');
  for (const node of session.topNodes) {
    lines.push(
      `- [${node.layer}/${node.category}] score=${node.score.toFixed(3)} raw=${node.rawScore.toFixed(3)} ` +
      `semantic=${node.semanticScore.toFixed(3)} coverage=${node.queryCoverage.toFixed(3)} risk=${node.outOfContextRisk.toFixed(3)}`
    );
    lines.push(`  key=${node.key} family=${node.family} domain=${node.domain ?? 'none'} because=${(node.selectedBecause ?? []).join(', ') || 'baseline relevance'}`);
    lines.push(`  ${node.value}`);
  }
  if (options.includeHeaders) {
    lines.push('full header:');
    lines.push(session.headerText || '(empty)');
  }
}

if (options.compare) {
  lines.push('\n## Cross-Session Overlap');
  for (const row of output.comparisons.slice(0, 10)) {
    lines.push(`- ${row.leftSessionId} vs ${row.rightSessionId}: overlap=${row.overlapCount} rate=${row.overlapRate.toFixed(2)}`);
  }
}

emit(`${lines.join('\n')}\n`, options.outputPath);
store.close();
