class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.41.tar.gz"
  sha256 "becc0e63ad6613642a79397065797028ee875297dd651e9ef8f4efd2330c465b"
  license "MIT"

  depends_on "git"
  depends_on "jq"
  depends_on "node@22"
  depends_on "ripgrep"
  depends_on "terminal-notifier"
  depends_on "tmux"
  depends_on "uv"

  def install
    libexec.install "benchmarks", "bin", "core", "shared", "teams", "tests", "VERSION"
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
    assert_match "OpenCode Team 0.1.41", shell_output("#{bin}/opencode-team version")
    assert_match "opencode-team start", shell_output("#{bin}/opencode-team --help")
    assert_predicate libexec/"core/lib/runtime-lifecycle.mjs", :file?
    assert_predicate libexec/"core/lib/runtime-reaper.sh", :file?
    ENV["HOME"] = (testpath/"user-home").to_s
    (testpath/"user-home").mkpath
    shared = testpath/"shared-dependencies"
    first = testpath/"home-a"
    second = testpath/"home-b"
    ENV["OPENCODE_TEAM_DEPENDENCY_ROOT"] = shared.to_s
    ENV["OPENCODE_TEAM_HOME"] = first.to_s
    system bin/"opencode-team", "setup"
    ENV["OPENCODE_TEAM_HOME"] = second.to_s
    system bin/"opencode-team", "setup"
    assert_empty (second/"data").glob("**/node_modules/oh-my-openagent")
    assert_predicate first/"state/maintenance/launchagents/it.danilodantoni.opencode-team.runtime-gc.plist", :file?
  end
end
