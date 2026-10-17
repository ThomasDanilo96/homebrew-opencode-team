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

File.write(output_path, source)
