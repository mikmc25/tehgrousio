// basic-test.js - Test scraper connectivity before touching main code

import { STREAM_SOURCES } from './const.js';

// Simple fetch function - no fancy DNS stuff, just basic connectivity
async function testFetchFromScrapers(sources, imdbId, type = 'movie') {
  const results = [];
  
  console.log(`\n🔍 Testing connectivity to ${Object.keys(sources).length} scrapers...`);
  console.log(`📋 Query: ${imdbId} (${type})\n`);
  
  for (const [key, source] of Object.entries(sources)) {
    try {
      const url = `${source.url}/api/search?type=${type}&query=${imdbId}`;
      console.log(`⏳ ${source.name}: ${url}`);
      
      const startTime = Date.now();
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });
      
      const responseTime = Date.now() - startTime;
      
      if (!response.ok) {
        console.log(`❌ ${source.name}: HTTP ${response.status} (${responseTime}ms)\n`);
        continue;
      }
      
      const data = await response.json();
      
      if (data.results && data.results.length > 0) {
        console.log(`✅ ${source.name}: ${data.results.length} results (${responseTime}ms)`);
        
        // Show first result as sample
        const sample = data.results[0];
        console.log(`   📝 Sample: ${sample.title}`);
        console.log(`   🎬 Quality: ${sample.quality || 'unknown'}`);
        console.log(`   🧲 Has magnet: ${sample.magnetLink ? 'Yes' : 'No'}\n`);
        
        // Add source info to results
        data.results.forEach(result => {
          result.source = source.name;
          result.sourceKey = key;
        });
        
        results.push(...data.results);
      } else {
        console.log(`📭 ${source.name}: No results found (${responseTime}ms)\n`);
      }
      
    } catch (error) {
      console.log(`❌ ${source.name}: ${error.message}\n`);
    }
  }
  
  console.log(`\n🎯 SUMMARY:`);
  console.log(`   Total results: ${results.length}`);
  console.log(`   Working scrapers: ${results.length > 0 ? 'YES' : 'NO'}`);
  
  if (results.length > 0) {
    // Group by quality
    const byQuality = {};
    results.forEach(r => {
      const q = r.quality || 'unknown';
      byQuality[q] = (byQuality[q] || 0) + 1;
    });
    
    console.log(`   Quality breakdown:`, byQuality);
    
    // Show sources that worked
    const workingSources = [...new Set(results.map(r => r.source))];
    console.log(`   Working sources: ${workingSources.join(', ')}`);
  }
  
  return results;
}

// Test with a known movie
async function runTest() {
  console.log('🚀 Starting scraper connectivity test...');
  
  try {
    // Test with The Death of Stalin (we know extto works for this)
    const testResults = await testFetchFromScrapers(STREAM_SOURCES, 'tt4686844', 'movie');
    
    if (testResults.length > 0) {
      console.log('\n✅ CONNECTIVITY TEST PASSED');
      console.log('   Your scrapers are working and can be connected to!');
      console.log('   Ready to integrate into main addon.');
    } else {
      console.log('\n❌ CONNECTIVITY TEST FAILED');
      console.log('   No scrapers returned results. Check network/URLs.');
    }
    
  } catch (error) {
    console.error('\n💥 TEST CRASHED:', error);
  }
}

// Run the test
runTest();