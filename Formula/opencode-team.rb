class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.64.tar.gz"
  sha256 "1ca51041072d14c50a070b12c1cb3df92fec8037b23888d90211fbbd2000d160"
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
    assert_predicate libexec/"core/lib/runtime-lifecycle.mjs", :file?
    assert_predicate libexec/"core/lib/runtime-reaper.sh", :file?
    assert_predicate libexec/"shared/maintenance/version-check.mjs", :file?
    assert_predicate libexec/"completions/_opencode-team", :file?
    if (libexec/"teams/deep-audit").directory?
      assert_predicate libexec/"teams/deep-audit/report-plugin.mjs.template", :file?
      assert_predicate libexec/"teams/deep-audit/scanner-plugin.mjs.template", :file?
      assert_predicate libexec/"teams/deep-audit/test-runner-plugin.mjs.template", :file?
      assert_predicate libexec/"teams/deep-audit/rules/semgrep.yml", :file?
      assert_predicate libexec/"teams/deep-audit/rules/ast-grep.yml", :file?
      assert_predicate libexec/"tests/deep-audit-cli.test.mjs", :file?
      assert_predicate libexec/"tests/deep-audit-test-runner.e2e.mjs", :file?
      assert_predicate libexec/"teams/deep-audit/bin/read-only-opencode.sh", :executable?
      # These setup scripts are invoked explicitly through bash by the launcher.
      assert_predicate libexec/"teams/deep-audit/setup-scanners.sh", :file?
      assert_predicate libexec/"teams/deep-audit/setup-test-runners.sh", :file?
    end
    assert_predicate zsh_completion/"_opencode-team", :file?
    system "zsh", "-n", zsh_completion/"_opencode-team"
    ENV["HOME"] = (testpath/"user-home").to_s
    (testpath/"user-home").mkpath
    ENV["OPENCODE_TEAM_TEST_SKIP_TIME_MACHINE"] = "1"
    shared = testpath/"shared-dependencies"
    first = testpath/"home-a"
    second = testpath/"home-b"
    ENV["OPENCODE_TEAM_DEPENDENCY_ROOT"] = shared.to_s
    ENV["OPENCODE_TEAM_HOME"] = first.to_s
    system bin/"opencode-team", "setup"
    assert_predicate first/"config/best-ecc/claude-config/settings.json", :file?
    assert_predicate first/"data/best-ecc/ecc/.opencode/plugins/ecc-hooks.ts", :file?
    assert_predicate first/"config/deep-audit/team-runtime.conf", :file?
    assert_predicate first/"data/deep-audit/ecc/skills/security-review/SKILL.md", :file?
    system bin/"opencode-team", "best-ecc-setup"
    assert_predicate first/"data/best-ecc/ecc/.opencode/plugins/ecc-hooks.ts", :file?
    assert_predicate first/"state/maintenance/launchagents/it.danilodantoni.opencode-team.version-check.plist", :file?
    ENV["OPENCODE_TEAM_HOME"] = second.to_s
    system bin/"opencode-team", "setup"
    assert_empty (second/"data").glob("**/node_modules/oh-my-openagent")
    assert_predicate first/"state/maintenance/launchagents/it.danilodantoni.opencode-team.runtime-gc.plist", :file?
  end
end
