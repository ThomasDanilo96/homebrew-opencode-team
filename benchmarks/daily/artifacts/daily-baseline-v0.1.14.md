# DAILY Benchmark Certification

- Suite: daily-baseline-1
- Package: 0.1.14
- Profile: baseline
- Tasks defined: 22
- Certification: UNASSESSED
- External evidence: AVAILABLE_UNVALIDATED

## Aggregate

```json
{
  "overall": {
    "count": 24,
    "quality": {
      "pass": 4,
      "partial": 0,
      "fail": 20
    },
    "wall_clock_ms": {
      "median": 803091,
      "p95": 1141454
    },
    "totals": {
      "time_to_first_meaningful_action_ms": null,
      "total_tokens": null,
      "input_tokens": null,
      "output_tokens": null,
      "cached_tokens": null,
      "estimated_cost": null,
      "delegation_count": 32,
      "parallel_fanout_peak": null,
      "retry_count": null,
      "max_depth": null
    },
    "missing_metrics": [
      "time_to_first_meaningful_action_ms",
      "total_tokens",
      "input_tokens",
      "output_tokens",
      "cached_tokens",
      "estimated_cost",
      "parallel_fanout_peak",
      "retry_count",
      "max_depth"
    ],
    "model_calls": {
      "Luna": 413,
      "Terra": 35,
      "Sol": 172,
      "other": 56
    },
    "gates": {
      "tester_required": 18,
      "tester_pass": 0,
      "tester_fail": 0,
      "tester_skipped_incorrectly": 15,
      "review_required": 16,
      "review_pass": 0,
      "review_reject": 0,
      "final_success_before_gate": 4
    }
  },
  "by_tier": {
    "COMPLEX": {
      "count": 6,
      "quality": {
        "pass": 3,
        "partial": 0,
        "fail": 3
      },
      "wall_clock_ms": {
        "median": 1024699,
        "p95": 1111736
      },
      "totals": {
        "time_to_first_meaningful_action_ms": null,
        "total_tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "estimated_cost": null,
        "delegation_count": 8,
        "parallel_fanout_peak": null,
        "retry_count": null,
        "max_depth": null
      },
      "missing_metrics": [
        "time_to_first_meaningful_action_ms",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost",
        "parallel_fanout_peak",
        "retry_count",
        "max_depth"
      ],
      "model_calls": {
        "Luna": 108,
        "Terra": 9,
        "Sol": 46,
        "other": 23
      },
      "gates": {
        "tester_required": 6,
        "tester_pass": 0,
        "tester_fail": 0,
        "tester_skipped_incorrectly": 5,
        "review_required": 6,
        "review_pass": 0,
        "review_reject": 0,
        "final_success_before_gate": 3
      }
    },
    "EXTREME": {
      "count": 4,
      "quality": {
        "pass": 1,
        "partial": 0,
        "fail": 3
      },
      "wall_clock_ms": {
        "median": 1138460,
        "p95": 1239368
      },
      "totals": {
        "time_to_first_meaningful_action_ms": null,
        "total_tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "estimated_cost": null,
        "delegation_count": 7,
        "parallel_fanout_peak": null,
        "retry_count": null,
        "max_depth": null
      },
      "missing_metrics": [
        "time_to_first_meaningful_action_ms",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost",
        "parallel_fanout_peak",
        "retry_count",
        "max_depth"
      ],
      "model_calls": {
        "Luna": 74,
        "Terra": 5,
        "Sol": 23,
        "other": 0
      },
      "gates": {
        "tester_required": 4,
        "tester_pass": 0,
        "tester_fail": 0,
        "tester_skipped_incorrectly": 3,
        "review_required": 4,
        "review_pass": 0,
        "review_reject": 0,
        "final_success_before_gate": 1
      }
    },
    "HEAVY": {
      "count": 4,
      "quality": {
        "pass": 0,
        "partial": 0,
        "fail": 4
      },
      "wall_clock_ms": {
        "median": 395759,
        "p95": 1121552
      },
      "totals": {
        "time_to_first_meaningful_action_ms": null,
        "total_tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "estimated_cost": null,
        "delegation_count": 6,
        "parallel_fanout_peak": null,
        "retry_count": null,
        "max_depth": null
      },
      "missing_metrics": [
        "time_to_first_meaningful_action_ms",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost",
        "parallel_fanout_peak",
        "retry_count",
        "max_depth"
      ],
      "model_calls": {
        "Luna": 46,
        "Terra": 13,
        "Sol": 25,
        "other": 6
      },
      "gates": {
        "tester_required": 2,
        "tester_pass": 0,
        "tester_fail": 0,
        "tester_skipped_incorrectly": 2,
        "review_required": 2,
        "review_pass": 0,
        "review_reject": 0,
        "final_success_before_gate": 0
      }
    },
    "NORMAL": {
      "count": 6,
      "quality": {
        "pass": 0,
        "partial": 0,
        "fail": 6
      },
      "wall_clock_ms": {
        "median": 521467,
        "p95": 1116355
      },
      "totals": {
        "time_to_first_meaningful_action_ms": null,
        "total_tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "estimated_cost": null,
        "delegation_count": 7,
        "parallel_fanout_peak": null,
        "retry_count": null,
        "max_depth": null
      },
      "missing_metrics": [
        "time_to_first_meaningful_action_ms",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost",
        "parallel_fanout_peak",
        "retry_count",
        "max_depth"
      ],
      "model_calls": {
        "Luna": 123,
        "Terra": 8,
        "Sol": 49,
        "other": 0
      },
      "gates": {
        "tester_required": 4,
        "tester_pass": 0,
        "tester_fail": 0,
        "tester_skipped_incorrectly": 3,
        "review_required": 4,
        "review_pass": 0,
        "review_reject": 0,
        "final_success_before_gate": 0
      }
    },
    "TRIVIAL": {
      "count": 4,
      "quality": {
        "pass": 0,
        "partial": 0,
        "fail": 4
      },
      "wall_clock_ms": {
        "median": 424553,
        "p95": 1117744
      },
      "totals": {
        "time_to_first_meaningful_action_ms": null,
        "total_tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "estimated_cost": null,
        "delegation_count": 4,
        "parallel_fanout_peak": null,
        "retry_count": null,
        "max_depth": null
      },
      "missing_metrics": [
        "time_to_first_meaningful_action_ms",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost",
        "parallel_fanout_peak",
        "retry_count",
        "max_depth"
      ],
      "model_calls": {
        "Luna": 62,
        "Terra": 0,
        "Sol": 29,
        "other": 27
      },
      "gates": {
        "tester_required": 2,
        "tester_pass": 0,
        "tester_fail": 0,
        "tester_skipped_incorrectly": 2,
        "review_required": 0,
        "review_pass": 0,
        "review_reject": 0,
        "final_success_before_gate": 0
      }
    }
  },
  "by_profile": {
    "daily": {
      "count": 12,
      "quality": {
        "pass": 2,
        "partial": 0,
        "fail": 10
      },
      "wall_clock_ms": {
        "median": 668684,
        "p95": 1239368
      },
      "totals": {
        "time_to_first_meaningful_action_ms": null,
        "total_tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "estimated_cost": null,
        "delegation_count": 18,
        "parallel_fanout_peak": null,
        "retry_count": null,
        "max_depth": null
      },
      "missing_metrics": [
        "time_to_first_meaningful_action_ms",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost",
        "parallel_fanout_peak",
        "retry_count",
        "max_depth"
      ],
      "model_calls": {
        "Luna": 254,
        "Terra": 28,
        "Sol": 0,
        "other": 0
      },
      "gates": {
        "tester_required": 9,
        "tester_pass": 0,
        "tester_fail": 0,
        "tester_skipped_incorrectly": 6,
        "review_required": 8,
        "review_pass": 0,
        "review_reject": 0,
        "final_success_before_gate": 2
      }
    },
    "openai": {
      "count": 12,
      "quality": {
        "pass": 2,
        "partial": 0,
        "fail": 10
      },
      "wall_clock_ms": {
        "median": 803091,
        "p95": 1141454
      },
      "totals": {
        "time_to_first_meaningful_action_ms": null,
        "total_tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "estimated_cost": null,
        "delegation_count": 14,
        "parallel_fanout_peak": null,
        "retry_count": null,
        "max_depth": null
      },
      "missing_metrics": [
        "time_to_first_meaningful_action_ms",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost",
        "parallel_fanout_peak",
        "retry_count",
        "max_depth"
      ],
      "model_calls": {
        "Luna": 159,
        "Terra": 7,
        "Sol": 172,
        "other": 56
      },
      "gates": {
        "tester_required": 9,
        "tester_pass": 0,
        "tester_fail": 0,
        "tester_skipped_incorrectly": 9,
        "review_required": 8,
        "review_pass": 0,
        "review_reject": 0,
        "final_success_before_gate": 2
      }
    }
  }
}
```

## DAILY vs OPENAI

```json
{
  "daily": {
    "count": 12,
    "quality": {
      "pass": 2,
      "partial": 0,
      "fail": 10
    },
    "wall_clock_ms": {
      "median": 668684,
      "p95": 1239368
    },
    "totals": {
      "time_to_first_meaningful_action_ms": null,
      "total_tokens": null,
      "input_tokens": null,
      "output_tokens": null,
      "cached_tokens": null,
      "estimated_cost": null,
      "delegation_count": 18,
      "parallel_fanout_peak": null,
      "retry_count": null,
      "max_depth": null
    },
    "missing_metrics": [
      "time_to_first_meaningful_action_ms",
      "total_tokens",
      "input_tokens",
      "output_tokens",
      "cached_tokens",
      "estimated_cost",
      "parallel_fanout_peak",
      "retry_count",
      "max_depth"
    ],
    "model_calls": {
      "Luna": 254,
      "Terra": 28,
      "Sol": 0,
      "other": 0
    },
    "gates": {
      "tester_required": 9,
      "tester_pass": 0,
      "tester_fail": 0,
      "tester_skipped_incorrectly": 6,
      "review_required": 8,
      "review_pass": 0,
      "review_reject": 0,
      "final_success_before_gate": 2
    }
  },
  "openai": {
    "count": 12,
    "quality": {
      "pass": 2,
      "partial": 0,
      "fail": 10
    },
    "wall_clock_ms": {
      "median": 803091,
      "p95": 1141454
    },
    "totals": {
      "time_to_first_meaningful_action_ms": null,
      "total_tokens": null,
      "input_tokens": null,
      "output_tokens": null,
      "cached_tokens": null,
      "estimated_cost": null,
      "delegation_count": 14,
      "parallel_fanout_peak": null,
      "retry_count": null,
      "max_depth": null
    },
    "missing_metrics": [
      "time_to_first_meaningful_action_ms",
      "total_tokens",
      "input_tokens",
      "output_tokens",
      "cached_tokens",
      "estimated_cost",
      "parallel_fanout_peak",
      "retry_count",
      "max_depth"
    ],
    "model_calls": {
      "Luna": 159,
      "Terra": 7,
      "Sol": 172,
      "other": 56
    },
    "gates": {
      "tester_required": 9,
      "tester_pass": 0,
      "tester_fail": 0,
      "tester_skipped_incorrectly": 9,
      "review_required": 8,
      "review_pass": 0,
      "review_reject": 0,
      "final_success_before_gate": 2
    }
  }
}
```

## Telemetry

- Existing daily-report packet count: 0
- Existing daily-report source: unavailable

## Contract

- DAILY verified: true
- Contract fingerprint: c4a8459736ef125845de636b15260ae7b126f0b21728490492a8a481ed79bf61
- External evidence path: /Users/thomasd/Sites/Github/brew-opencode-team/benchmarks/daily/artifacts/openai-daily-real-paired-v0.1.14.jsonl

