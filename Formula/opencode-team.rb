class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.47.tar.gz"
  sha256 "ebe02bc4bd1f83d2461824b2e5dd8d3ab7a57467865e6a33653ed435bcdc9c5a"
  license "MIT"

  depends_on "git"
  depends_on "jq"
  depends_on "node@22"
  depends_on "ripgrep"
  depends_on "terminal-notifier"
  depends_on "tmux"
  depends_on "uv"

  def install
    zsh_completion.install "completions/_opencode-team"
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
    assert_match "OpenCode Team 0.1.47", shell_output("#{bin}/opencode-team version")
    help = shell_output("#{bin}/opencode-team --help")
    assert_match "BEST profile", help
    assert_match "free", help
    assert_match "alias for best", help
    assert_match "best-native", help
    assert_predicate libexec/"core/lib/runtime-lifecycle.mjs", :file?
    assert_predicate libexec/"core/lib/runtime-reaper.sh", :file?
    assert_predicate libexec/"shared/maintenance/version-check.mjs", :file?
    assert_predicate libexec/"completions/_opencode-team", :file?
    assert_predicate zsh_completion/"_opencode-team", :file?
    system "zsh", "-n", zsh_completion/"_opencode-team"
    ENV["HOME"] = (testpath/"user-home").to_s
    (testpath/"user-home").mkpath
    shared = testpath/"shared-dependencies"
    first = testpath/"home-a"
    second = testpath/"home-b"
    ENV["OPENCODE_TEAM_DEPENDENCY_ROOT"] = shared.to_s
    ENV["OPENCODE_TEAM_HOME"] = first.to_s
    system bin/"opencode-team", "setup"
    assert_predicate first/"state/maintenance/launchagents/it.danilodantoni.opencode-team.version-check.plist", :file?
    ENV["OPENCODE_TEAM_HOME"] = second.to_s
    system bin/"opencode-team", "setup"
    assert_empty (second/"data").glob("**/node_modules/oh-my-openagent")
    assert_predicate first/"state/maintenance/launchagents/it.danilodantoni.opencode-team.runtime-gc.plist", :file?
  end
end
