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

const args = process.argv.slice(2);
let sessionsDir = '/home/michael/.openclaw/agents/main/sessions';
let dbPath = process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db';
let tokenBudget = 1000;
let recentLimit = 12;
let asJson = false;
let compare = true;
const topics = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--db' && args[i + 1]) dbPath = args[++i];
  else if (arg === '--sessions' && args[i + 1]) sessionsDir = args[++i];
  else if (arg === '--budget' && args[i + 1]) tokenBudget = Number(args[++i]);
  else if (arg === '--recent-limit' && args[i + 1]) recentLimit = Number(args[++i]);
  else if (arg === '--json') asJson = true;
  else if (arg === '--no-compare') compare = false;
  else topics.push(arg);
}

const selectedTopics = topics.length ? topics : ['540', '12', '10', '1'];

function latestSessionForTopic(topicId) {
  const files = fs.readdirSync(sessionsDir)
    .filter((file) => file.endsWith(`topic-${topicId}.jsonl`))
    .map((file) => {
      const full = path.join(sessionsDir, file);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.full;
}

function extractRecentMessages(filePath, limit = 12) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const texts = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.type !== 'message') continue;
      const msg = row.message;
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const content = Array.isArray(msg.content)
        ? msg.content.map((part) => part?.text || '').join('\n')
        : typeof msg.content === 'string' ? msg.content : '';
      if (content.trim()) texts.push(`${msg.role}: ${content.trim()}`);
    } catch {}
  }
  return texts.slice(-limit).join('\n');
}

function summarizeTopic(topicId, sessionFile, header, recentMessages) {
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
    topicId,
    session: sessionFile ? path.basename(sessionFile) : null,
    recentMessages,
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

function compareTopics(topicSummaries) {
  const comparisons = [];
  for (let i = 0; i < topicSummaries.length; i++) {
    for (let j = i + 1; j < topicSummaries.length; j++) {
      const left = topicSummaries[i];
      const right = topicSummaries[j];
      const leftKeys = new Set(left.selectedKeys);
      const rightKeys = new Set(right.selectedKeys);
      let overlap = 0;
      for (const key of leftKeys) {
        if (rightKeys.has(key)) overlap++;
      }
      const union = new Set([...leftKeys, ...rightKeys]).size;
      comparisons.push({
        leftTopic: left.topicId,
        rightTopic: right.topicId,
        overlapCount: overlap,
        overlapRate: union === 0 ? 0 : overlap / union,
      });
    }
  }
  return comparisons.sort((a, b) => b.overlapRate - a.overlapRate);
}

const store = createStore(dbPath);
const injector = createInjector(store, { tokenBudget });
const topicSummaries = [];

for (const topic of selectedTopics) {
  const sessionFile = latestSessionForTopic(topic);
  if (!sessionFile) {
    topicSummaries.push({
      topicId: topic,
      session: null,
      error: 'No session file found.',
      selectedKeys: [],
    });
    continue;
  }

  const recentMessages = extractRecentMessages(sessionFile, recentLimit);
  const header = injector.assemble({ recentMessages });
  topicSummaries.push(summarizeTopic(topic, sessionFile, header, recentMessages));
}

const output = {
  dbPath,
  sessionsDir,
  tokenBudget,
  topics: topicSummaries,
  comparisons: compare ? compareTopics(topicSummaries.filter((topic) => !topic.error)) : [],
};

if (asJson) {
  console.log(JSON.stringify(output, null, 2));
  store.close();
  process.exit(0);
}

console.log('## Memrok Topic Eval');
console.log(`dbPath: ${dbPath}`);
console.log(`sessionsDir: ${sessionsDir}`);
console.log(`tokenBudget: ${tokenBudget}`);

for (const topic of topicSummaries) {
  console.log(`\n## Topic ${topic.topicId}`);
  if (topic.error) {
    console.log(topic.error);
    continue;
  }
  console.log(`session: ${topic.session}`);
  console.log(`domainFocus: ${topic.domainFocus ?? 'none'}`);
  console.log(`tokens=${topic.tokens} nodesUsed=${topic.nodesUsed}`);
  console.log(
    `relevanceHitRate=${topic.relevanceHitRate.toFixed(2)} outOfContext=${topic.outOfContextCount} ` +
    `bleed=${topic.crossDomainBleedCount} dominantFamily=${topic.dominantFamily.family ?? 'none'}:${topic.dominantFamily.count} ` +
    `share=${topic.dominantFamily.share.toFixed(2)}`
  );
  console.log(`domains=${JSON.stringify(topic.selectedDomains)}`);
  console.log(`categories=${JSON.stringify(topic.categories)}`);
  console.log(`attribution=${JSON.stringify(topic.attributionCounts)}`);
  console.log('top nodes:');
  for (const node of topic.topNodes) {
    console.log(
      `- [${node.layer}/${node.category}] score=${node.score.toFixed(3)} raw=${node.rawScore.toFixed(3)} ` +
      `semantic=${node.semanticScore.toFixed(3)} coverage=${node.queryCoverage.toFixed(3)} risk=${node.outOfContextRisk.toFixed(3)}`
    );
    console.log(`  key=${node.key} family=${node.family} domain=${node.domain ?? 'none'} because=${(node.selectedBecause ?? []).join(', ') || 'baseline relevance'}`);
    console.log(`  ${node.value}`);
  }
}

if (compare) {
  console.log('\n## Cross-Topic Overlap');
  for (const row of output.comparisons.slice(0, 10)) {
    console.log(`- ${row.leftTopic} vs ${row.rightTopic}: overlap=${row.overlapCount} rate=${row.overlapRate.toFixed(2)}`);
  }
}

store.close();
