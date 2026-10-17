class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.66.tar.gz"
  sha256 "6ac1af38c2e63a918c576805e88b5677328c75f0e49ae723057ff97ce71140df"
  license "MIT"

  depends_on "git"
  depends_on "jq"
  depends_on "node@22"
  depends_on "ripgrep"
  depends_on "terminal-notifier"
  depends_on "tmux"
  depends_on "uv"

  def install
    zsh_completion.mkpath
    cp "completions/_opencode-team", zsh_completion/"_opencode-team"
    libexec.install "benchmarks", "bin", "completions", "core", "shared", "teams", "tests", "VERSION"
    (bin/"opencode-team").write <<~EOS
      #!/bin/bash
      export PATH="#{formula_opt_bin("node@22")}:$PATH"
      exec "#{opt_prefix}/libexec/bin/opencode-team" "$@"
    EOS
    chmod 0755, bin/"opencode-team"
    (bin/"opencode-daily-team").write <<~EOS
      #!/bin/bash
      export PATH="#{formula_opt_bin("node@22")}:$PATH"
      exec "#{opt_prefix}/libexec/bin/opencode-daily-team" "$@"
    EOS
    chmod 0755, bin/"opencode-daily-team"
  end

  test do
    expected_version = version.to_s
    assert_equal expected_version, (libexec/"VERSION").read.strip
    assert_match "OpenCode Team #{expected_version}", shell_output("#{bin}/opencode-team version")
    help = shell_output("#{bin}/opencode-team --help")
    assert_match "BEST profile", help
    assert_match "free", help
    assert_match "alias for best", help
    assert_match "best-native", help
    assert_match "best-ecc", help
    assert_predicate bin/"opencode-team", :executable?
    assert_predicate bin/"opencode-daily-team", :executable?
    assert_predicate libexec/"core/lib/runtime-lifecycle.mjs", :file?
    assert_predicate libexec/"core/lib/runtime-reaper.sh", :file?
    assert_predicate libexec/"shared/maintenance/version-check.mjs", :file?
    assert_predicate libexec/"completions/_opencode-team", :file?
    assert_predicate libexec/"tests/setup-smoke.sh", :file?
    assert_predicate libexec/"tests/setup-smoke.sh", :executable?
    if (libexec/"teams/deep-audit").directory?
      deep_audit_assets = %w[
        teams/deep-audit/team-runtime.conf.template
        teams/deep-audit/opencode.jsonc.template
        teams/deep-audit/runtime-env.sh
        teams/deep-audit/setup-ecc.sh
        teams/deep-audit/setup-scanners.sh
        teams/deep-audit/setup-test-runners.sh
        teams/deep-audit/test-runner-integrity.mjs
        teams/deep-audit/report-plugin.mjs.template
        teams/deep-audit/scanner-plugin.mjs.template
        teams/deep-audit/test-runner-plugin.mjs.template
        teams/deep-audit/report-schema.md
        teams/deep-audit/bin/read-only-opencode.sh
        teams/deep-audit/bin/report.mjs
        teams/deep-audit/bin/test-runner-health.mjs
        teams/deep-audit/scanners/package.json
        teams/deep-audit/scanners/package-lock.json
        teams/deep-audit/scanners/pyproject.toml
        teams/deep-audit/scanners/uv.lock
        teams/deep-audit/rules/semgrep.yml
        teams/deep-audit/rules/ast-grep.yml
        teams/deep-audit/test-runners/images.lock.json
        teams/deep-audit/test-runners/python.Dockerfile
        teams/deep-audit/test-runners/php.Dockerfile
        teams/deep-audit/test-runners/python-requirements.txt
        tests/deep-audit-cli.test.mjs
        tests/deep-audit-report.test.mjs
        tests/deep-audit-scanner.test.mjs
        tests/deep-audit-sandbox.test.sh
        tests/deep-audit-runtime-smoke.sh
        tests/deep-audit-test-runner.e2e.mjs
        tests/deep-audit-plugin-registration.test.mjs
      ]
      deep_audit_assets.each { |asset| assert_predicate libexec/asset, :file? }
      assert_predicate libexec/"teams/deep-audit/test-runners", :directory?
      assert_predicate libexec/"teams/deep-audit/bin/read-only-opencode.sh", :executable?
      assert_predicate libexec/"tests/deep-audit-sandbox.test.sh", :executable?
    end
    assert_predicate zsh_completion/"_opencode-team", :file?
    system "zsh", "-n", zsh_completion/"_opencode-team"
    external_path = testpath/"unrelated-working-directory"
    external_path.mkpath
    Dir.chdir(external_path) do
      assert_match "OpenCode Team #{expected_version}", shell_output("#{bin}/opencode-team version")
    end
  end
end
