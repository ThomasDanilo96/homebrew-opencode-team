class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.18.tar.gz"
  sha256 "3e3a25b5ecece6f195d5acddc829675d7bbdb564804b3e49368e5d63fc86f49e"
  license "MIT"

  depends_on "git"
  depends_on "jq"
  depends_on "node@22"
  depends_on "ripgrep"
  depends_on "tmux"
  depends_on "uv"

  def install
    libexec.install "bin", "core", "shared", "teams", "tests", "VERSION"
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
    assert_match "OpenCode Team 0.1.18", shell_output("#{bin}/opencode-team version")
    assert_match "opencode-team start", shell_output("#{bin}/opencode-team --help")
    assert_predicate libexec/"core/lib/runtime-lifecycle.mjs", :file?
    assert_predicate libexec/"core/lib/runtime-reaper.sh", :file?
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
