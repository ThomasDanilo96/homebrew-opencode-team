class OpencodeTeam < Formula
  desc "Isolated BEST and FREE profiles for native OpenCode V2"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.3.5.tar.gz"
  sha256 "ee4928000ca6e2e35744486e246ec47ccfc8c2e002022fa2d276274afdf64f21"
  license "MIT"

  depends_on "git"
  depends_on "node@22"
  depends_on "uv"

  def install
    zsh_completion.install "completions/_opencode-team"
    libexec.install "bin", "completions", "shared", "VERSION"
    (libexec/"tests").install "tests/native-profiles.test.mjs", "tests/setup-smoke.sh"
    (bin/"opencode-team").write <<~EOS
      #!/bin/bash
      export PATH="#{formula_opt_bin("node@22")}:$PATH"
      exec "#{opt_prefix}/libexec/bin/opencode-team" "$@"
    EOS
    chmod 0755, bin/"opencode-team"
  end

  test do
    expected_version = version.to_s
    assert_equal expected_version, (libexec/"VERSION").read.strip
    assert_match "OpenCode Team #{expected_version}", shell_output("#{bin}/opencode-team version")
    help = shell_output("#{bin}/opencode-team --help")
    assert_match "BEST", help
    assert_match "FREE", help
    refute_match(/best-ecc|best-native|opencode-daily-team/, help)
    assert_predicate bin/"opencode-team", :executable?
    assert_predicate libexec/"shared/profiles.mjs", :file?
    assert_predicate libexec/"shared/instructions.md", :file?
    assert_equal "b92f181b3b748d1abbc2afd94af6aa7d8c8fca29", (libexec/"shared/ecc.lock").read.strip
    assert_predicate libexec/"tests/setup-smoke.sh", :executable?
    assert_predicate zsh_completion/"_opencode-team", :file?
    system "zsh", "-n", zsh_completion/"_opencode-team"
    system "bash", libexec/"tests/setup-smoke.sh"
    external_path = testpath/"unrelated-working-directory"
    external_path.mkpath
    Dir.chdir(external_path) do
      assert_match "OpenCode Team #{expected_version}", shell_output("#{bin}/opencode-team version")
    end
  end
end
