#!/usr/bin/env python3
"""Dice roller for the TTRPG Memory extension.

Usage:
    python dice.py --expr="2d6+3" [--mode=normal|advantage|disadvantage] [--dc=15]

Supported expression syntax (terms joined with + or -):
    NdM        roll N dice with M sides, e.g. 3d6
    dM         same as 1dM
    NdMkhK     roll NdM and keep the K highest, e.g. 4d6kh3
    NdMklK     keep the K lowest
    NdMdhK     drop the K highest
    NdMdlK     drop the K lowest
    N          flat modifier

The result is printed to stdout as a single JSON object.
Errors are printed as {"error": "..."} with exit code 2.
"""

import argparse
import json
import re
import sys
from random import SystemRandom

MAX_DICE = 100
MAX_SIDES = 1000
MAX_TERMS = 20
MAX_EXPR_LENGTH = 100

rng = SystemRandom()

TERM_RE = re.compile(
    r"^(?P<sign>[+-])?(?:(?P<count>\d*)d(?P<sides>\d+)(?:(?P<keep>kh|kl|dh|dl)(?P<keepn>\d+))?|(?P<flat>\d+))$",
    re.IGNORECASE,
)


class DiceError(ValueError):
    pass


def tokenize(expr):
    expr = re.sub(r"\s+", "", expr)
    if not expr:
        raise DiceError("Empty expression")
    if len(expr) > MAX_EXPR_LENGTH:
        raise DiceError("Expression is too long")
    parts = re.findall(r"[+-]?[^+-]+", expr)
    if "".join(parts) != expr:
        raise DiceError(f"Cannot parse expression: {expr}")
    if len(parts) > MAX_TERMS:
        raise DiceError("Too many terms")
    return parts


def apply_mode(term, mode):
    """Turn a single d20 into advantage / disadvantage."""
    if mode == "normal":
        return term, False
    match = TERM_RE.match(term)
    if not match or match["sides"] != "20" or match["keep"] or (match["count"] or "1") != "1":
        return term, False
    sign = match["sign"] or ""
    return f"{sign}2d20{'kh' if mode == 'advantage' else 'kl'}1", True


def roll_term(term):
    match = TERM_RE.match(term)
    if not match:
        raise DiceError(f"Cannot parse term: {term}")

    sign = -1 if match["sign"] == "-" else 1

    if match["flat"] is not None:
        value = int(match["flat"])
        return {"term": term.lstrip("+"), "flat": value, "subtotal": sign * value}

    count = int(match["count"] or 1)
    sides = int(match["sides"])
    if not 1 <= count <= MAX_DICE:
        raise DiceError(f"Dice count must be between 1 and {MAX_DICE}")
    if not 2 <= sides <= MAX_SIDES:
        raise DiceError(f"Dice sides must be between 2 and {MAX_SIDES}")

    rolls = [rng.randint(1, sides) for _ in range(count)]
    kept = list(rolls)

    if match["keep"]:
        mode = match["keep"].lower()
        n = int(match["keepn"])
        if n > count:
            raise DiceError("Cannot keep or drop more dice than rolled")
        ordered = sorted(rolls)
        if mode == "kh":
            kept = ordered[count - n:]
        elif mode == "kl":
            kept = ordered[:n]
        elif mode == "dh":
            kept = ordered[:count - n]
        else:  # dl
            kept = ordered[n:]

    return {
        "term": term.lstrip("+"),
        "sides": sides,
        "rolls": rolls,
        "kept": kept,
        "subtotal": sign * sum(kept),
    }


def roll(expr, mode="normal", dc=None):
    terms = []
    advantage_applied = False
    for part in tokenize(expr):
        part, applied = apply_mode(part, mode)
        advantage_applied = advantage_applied or applied
        terms.append(roll_term(part))

    total = sum(t["subtotal"] for t in terms)
    result = {
        "expression": expr.replace(" ", ""),
        "mode": mode if advantage_applied else "normal",
        "terms": terms,
        "total": total,
    }

    # Natural 20 / natural 1 on a plain d20 (or the kept die of advantage / disadvantage).
    d20_terms = [t for t in terms if t.get("sides") == 20 and len(t["kept"]) == 1]
    if len(d20_terms) == 1:
        natural = d20_terms[0]["kept"][0]
        result["natural"] = natural
        result["critical"] = "success" if natural == 20 else "failure" if natural == 1 else None

    if dc is not None:
        result["dc"] = dc
        result["success"] = total >= dc

    return result


def main():
    parser = argparse.ArgumentParser(description="TTRPG dice roller")
    parser.add_argument("--expr", required=True)
    parser.add_argument("--mode", choices=["normal", "advantage", "disadvantage"], default="normal")
    parser.add_argument("--dc", type=int, default=None)
    args = parser.parse_args()

    try:
        print(json.dumps(roll(args.expr, args.mode, args.dc), ensure_ascii=False))
    except DiceError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(2)


if __name__ == "__main__":
    main()
