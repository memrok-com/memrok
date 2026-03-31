#!/usr/bin/env python3
"""Test scribe extraction against real transcripts using different models."""

import json
import sys
import re
import subprocess
import os

def extract_conversation(filepath, max_turns=40):
    """Extract clean conversation turns from JSONL."""
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
                text = _extract_user_text(content)
                if text and not text.startswith("HEARTBEAT") and not text.startswith("A new session was started"):
                    turns.append(f"[USER]: {text}")
            elif role == "assistant":
                text = _extract_assistant_text(content)
                if text:
                    turns.append(f"[ASSISTANT]: {text}")
    
    return turns[:max_turns]

def _extract_user_text(content):
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(c.get("text", "") for c in content if c.get("type") == "text")
    else:
        return ""
    pattern = r'^Conversation info \(untrusted metadata\):.*?```\s*\n\s*(?:Sender \(untrusted metadata\):.*?```\s*\n\s*)?'
    text = re.sub(pattern, '', text, flags=re.DOTALL)
    return text.strip()

def _extract_assistant_text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts = [c["text"] for c in content if c.get("type") == "text"]
        return "\n".join(texts).strip()
    return ""

def load_system_prompt():
    prompt_path = os.path.join(os.path.dirname(__file__), "system-prompt.md")
    with open(prompt_path) as f:
        return f.read()

def run_extraction(transcript_text, model="anthropic/claude-sonnet-4-6", provider="anthropic"):
    """Call a model with the scribe prompt and transcript."""
    system_prompt = load_system_prompt()
    
    user_message = f"""Here is a conversation transcript to process. Extract structured knowledge into graph mutations.

<transcript>
{transcript_text}
</transcript>

Output your extraction as a single JSON object following the schema in your instructions. Be thorough but conservative — only extract durable knowledge with clear evidence."""

    # Use OpenClaw's gateway to route the model call
    # For now, just output what we'd send
    print(f"\n{'='*60}")
    print(f"MODEL: {model}")
    print(f"TRANSCRIPT: {len(transcript_text)} chars")
    print(f"{'='*60}")
    
    return system_prompt, user_message

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: test-extraction.py <jsonl-path> [max-turns]")
        sys.exit(1)
    
    filepath = sys.argv[1]
    max_turns = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    
    turns = extract_conversation(filepath, max_turns)
    transcript = "\n\n".join(turns)
    
    print(f"Extracted {len(turns)} turns, {len(transcript)} chars")
    
    # Save the extracted transcript for manual testing
    out_path = os.path.join(os.path.dirname(filepath), "extracted-sample.txt")
    # Actually save alongside the script
    out_path = os.path.join(os.path.dirname(__file__), "test-transcript.txt")
    with open(out_path, "w") as f:
        f.write(transcript)
    print(f"Saved to {out_path}")
    
    system_prompt, user_message = run_extraction(transcript)
    
    # Save the full prompt for manual testing
    prompt_path = os.path.join(os.path.dirname(__file__), "test-prompt.txt")
    with open(prompt_path, "w") as f:
        f.write("=== SYSTEM PROMPT ===\n")
        f.write(system_prompt)
        f.write("\n\n=== USER MESSAGE ===\n")
        f.write(user_message)
    print(f"Full prompt saved to {prompt_path}")
