#!/usr/bin/env ruby

abort "usage: render-staging-formula.rb SOURCE_FORMULA OUTPUT_FORMULA CLASS VERSION URL SHA256" unless ARGV.length == 6

source_path, output_path, class_name, version, url, sha256 = ARGV
abort "invalid Formula class name" unless class_name.match?(/\A[A-Z][A-Za-z0-9]*\z/)
abort "invalid stable version" unless version.match?(/\A\d+\.\d+\.\d+\z/)
abort "invalid SHA-256" unless sha256.match?(/\A[0-9a-f]{64}\z/)
abort "only file and HTTPS staging URLs are permitted" unless url.start_with?("file://", "https://")

source = File.read(source_path)
source.sub!(/^class OpencodeTeam < Formula$/, "class #{class_name} < Formula") || abort("source formula class not found")
source.gsub!(/^  disable! .*\n/, "")
source.sub!(/^  url .*$/, "  url #{url.dump}") || abort("source formula URL not found")
source.sub!(/^(  url .*\n)/) { "#{$1}  version #{version.dump}\n" } || abort("could not set staging formula version")
source.sub!(/^  sha256 .*$/, "  sha256 #{sha256.dump}") || abort("source formula SHA-256 not found")
abort "source formula license not found" unless source.match?(/^  license /)

# Staging candidate installs the guardrail test surface (runner, isolation controls,
# Node suites, maintenance + setup-smoke under the runner, and .github scripts the
# runner drives). It must not reference setup-smoke.sh as a raw, non-isolated fallback.
source.sub!(
  /\(libexec\/"tests"\)\.install "tests\/native-profiles\.test\.mjs", "tests\/setup-smoke\.sh", "tests\/test_maintenance\.py"/,
  "(libexec/\"tests\").install \"tests/test_isolation.py\", \"tests/test_maintenance.py\", \"tests/test_maintenance_evidence.py\", \"tests/setup-smoke.sh\"\n    (libexec/\"tests\").install Dir[\"tests/*.test.mjs\"]\n    (libexec/\"tests/guardrail\").install Dir[\"tests/guardrail/*\"]\n    libexec.install \".github\""
) || abort("source formula test install line not found")

# Staging test block uses the guardrail runner (smoke), not the raw setup-smoke.sh.
source.sub!(
  /    system "bash", libexec\/"tests\/setup-smoke\.sh"\n/,
  "    assert_predicate libexec/\"tests/guardrail/runner.sh\", :executable?\n    assert_predicate libexec/\"tests/test_isolation.py\", :file?\n    assert_predicate libexec/\"tests/native-profiles.test.mjs\", :file?\n    assert_predicate libexec/\"tests/guardrail/assert-isolated.mjs\", :file?\n    assert_predicate libexec/\"tests/guardrail/profile.sb\", :file?\n    assert_predicate libexec/\".github\", :directory?\n    system \"bash\", libexec/\"tests/guardrail/runner.sh\", \"smoke\"\n"
) || abort("source formula test block setup-smoke invocation not found")

File.write(output_path, source)
