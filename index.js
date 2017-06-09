#!/usr/bin/env node

var crawler = require('npm-license-crawler');
var fs = require('fs');
var request = require('request');
var async = require('async');
var path = require('path');
var parseLicense = require('license-checker/lib/license');
var mkdirp = require('mkdirp');
var crypto = require('crypto');

var argv = require('minimist')(process.argv.slice(2));
var dir = argv.dir || process.cwd();
var outFile = argv.output || dir + '/LICENSES.txt';
var cdn = argv.env === 'dev' ? 'https://livefyre-cdn-dev.s3.amazonaws.com' :
          argv.env === 'qa' ? 'https://livefyre-cdn-qa.s3.amazonaws.com' :
          argv.env === 'staging' ? 'https://livefyre-cdn-staging.s3.amazonaws.com' :
          'https://cdn.livefyre.com';

var package = require(dir + '/package.json');
var url = cdn + '/libs/' + package.name + '/v' + package.version + '/' + path.basename(outFile);

var cacheDir = argv.cache || '/tmp/license-extractor-cache';
mkdirp.sync(cacheDir);

// Crawl licenses for all dependencies
crawler.dumpLicenses({start: dir, relativeLicensePath: true}, function (err, licenses) {
  async.forEachLimit(Object.keys(licenses), 20, function (key, next) {
    var license = licenses[key];
    if (!license.licenseUrl) {
      return next();
    }

    license.key = key;

    // If we have a local license file, use that.
    if (license.licenseFile) {
      licenses[key].licenseText = fs.readFileSync(path.resolve(dir, licenses[key].licenseFile), 'utf8');
      return next();
    }

    // If the license url is just the Github repo homepage, try a bunch of possible files
    if (license.licenseUrl === license.repository.replace('git://', 'https://')) {
      if (/github\.com/.test(license.licenseUrl)) {
        return async.forEach(['LICENSE', 'LICENSE.md', 'license', 'license.md'], function (file, next) {
          if (license.licenseText) {
            return next();
          }

          let url = license.licenseUrl.replace(/(https?:\/\/github\.com\/[^\/]+\/[^\/]+).*$/, '$1');
          requestLicense(license, url + '/raw/master/' + file, next);
        }, next);
      }

      return next();
    }

    if (/github\.com/.test(license.licenseUrl)) {
      license.licenseUrl = license.licenseUrl.replace('/blob/', '/raw/');
    }

    requestLicense(license, license.licenseUrl, next);
  }, function () {
    // Output licenses to a file
    var output = fs.createWriteStream(outFile);
    var projects = {};
    for (var key in licenses) {
      // Skip duplicates
      var project = key.split('@')[0];
      if (projects[project]) {
        continue;
      }

      projects[project] = true;

      // Skip internal non-opensource projects
      var license = licenses[key];
      if (/storify|livefyre/i.test(license.repository + key)) {
        continue;
      }

      if (!license.licenseText) {
        console.log('Could not resolve license text for ' + (license.repository || key));
      }

      output.write('Project: ' + project + '\nURL: ' + license.repository + '\nLicense: ' + license.licenses + '\n\n' + (license.licenseText || '') + '\n\n');
    }

    output.end();

    // Write header to file
    if (argv.prepend) {
      var header = fs.readFileSync(__dirname + '/header.txt', 'utf8');
      header = header.replace('{{year}}', new Date().getFullYear());
      header = header.replace('{{url}}', url);
      var file = fs.readFileSync(argv.prepend);
      fs.writeFileSync(argv.prepend, header + file);
    }
  });
});

function requestLicense(license, url, callback) {
  // Check the cache dir to see if we already have this license file
  var hash = crypto.createHash('md5').update(license.key + license.url).digest("hex");
  var cacheFile = cacheDir + '/' + hash;
  if (fs.existsSync(cacheFile)) {
    return fs.readFile(cacheFile, 'utf8', callback);
  }

  request(url, function (err, res, body) {
    if (err) {
      return callback(err);
    }

    if (res.statusCode === 200 && /text\/plain/.test(res.headers['content-type']) && body) {
      license.resolvedLicenseUrl = url;
      license.licenseText = body;
      if (license.license === 'UKNOWN') {
        license.license = parseLicense(body);
      }

      fs.writeFileSync(cacheFile, body);
    }

    callback();
  });
}
