#!/usr/bin/env python3
"""Extract clean user/assistant conversation from OpenClaw JSONL transcripts.
Strips tool calls, thinking, metadata envelopes — keeps the human-readable exchange."""

import json
import sys
import re

def extract_user_text(content):
    """Extract just the user's actual message from the metadata envelope."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(c.get("text", "") for c in content if c.get("type") == "text")
    else:
        return ""
    
    # Strip the conversation info + sender metadata blocks
    # They follow a pattern: "Conversation info (untrusted metadata):\n```json...```\n\nSender (untrusted metadata):\n```json...```\n\n<actual message>"
    pattern = r'^Conversation info \(untrusted metadata\):.*?```\s*\n\s*(?:Sender \(untrusted metadata\):.*?```\s*\n\s*)?'
    text = re.sub(pattern, '', text, flags=re.DOTALL)
    return text.strip()

def extract_assistant_text(content):
    """Extract just the assistant's text response, skip tool calls and thinking."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts = []
        for c in content:
            if c.get("type") == "text":
                texts.append(c["text"])
        return "\n".join(texts).strip()
    return ""

def process_transcript(filepath, max_turns=None):
    """Process a JSONL transcript file into clean conversation turns."""
    turns = []
    with open(filepath) as f:
        for line in f:
            obj = json.loads(line)
            if obj.get("type") != "message":
                continue
            msg = obj.get("message", {})
            role = msg.get("role")
            content = msg.get("content", "")
            
            if role == "user":
                text = extract_user_text(content)
                if text and not text.startswith("HEARTBEAT"):
                    turns.append({"role": "user", "text": text})
            elif role == "assistant":
                text = extract_assistant_text(content)
                if text:
                    turns.append({"role": "assistant", "text": text})
    
    if max_turns:
        turns = turns[:max_turns]
    return turns

if __name__ == "__main__":
    filepath = sys.argv[1]
    max_turns = int(sys.argv[2]) if len(sys.argv) > 2 else None
    turns = process_transcript(filepath, max_turns)
    
    for turn in turns:
        print(f"\n{'='*60}")
        print(f"[{turn['role'].upper()}]")
        print(f"{'='*60}")
        print(turn['text'][:500])
        if len(turn['text']) > 500:
            print(f"... [{len(turn['text'])} chars total]")
