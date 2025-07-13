import { PgVector } from '@mastra/pg';
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
config({ path: '.env.development' });

interface ChunkData {
  id: string;
  content: string;
  metadata: {
    source: string;
    section: string;
    index: number;
  };
}

export async function setupPierreRAG() {
  const vectorStore = new PgVector({
    connectionString: process.env.DATABASE_URL!,
    schemaName: 'pierre_docs',
  });

  await vectorStore.createIndex({
    indexName: 'pierre_trading_system',
    dimension: 1536, // OpenAI embedding dimension
    metric: 'cosine',
  });

  const tradingSystemPath = join(process.cwd(), 'pierre-trading-system.md');
  const content = readFileSync(tradingSystemPath, 'utf-8');

  const chunks = chunkContent(content);
  console.log(`Processing ${chunks.length} chunks...`);
  
  const batchSize = 10;
  let processed = 0;
  
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
    
    const embeddings = [];
    const metadataArray = [];
    const ids = [];
    
    for (const chunk of batch) {
      const { embedding } = await embed({
        model: openai.embedding('text-embedding-3-small'),
        value: chunk.content,
      });

      embeddings.push(embedding);
      metadataArray.push({ ...chunk.metadata, content: chunk.content });
      ids.push(chunk.id);
      processed++;
    }

    await vectorStore.upsert({
      indexName: 'pierre_trading_system',
      vectors: embeddings,
      metadata: metadataArray,
      ids: ids,
    });
    
    console.log(`Processed ${processed}/${chunks.length} chunks`);
  }

  console.log(`Successfully embedded ${chunks.length} chunks for Pierre's trading system`);
}

function chunkContent(content: string): ChunkData[] {
  const chunks: ChunkData[] = [];
  const sections = content.split(/(?=^##\s)/m);

  sections.forEach((section, sectionIndex) => {
    if (section.trim().length === 0) return;

    const lines = section.split('\n');
    const sectionTitle = lines[0]?.replace(/^#+\s*/, '') || 'Unknown Section';
    
    const paragraphs = section.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    paragraphs.forEach((paragraph, paragraphIndex) => {
      if (paragraph.trim().length < 100) return; // Skip very short paragraphs
      
      const words = paragraph.split(/\s+/);
      const maxWordsPerChunk = 400; // ~512 tokens with overlap
      const overlap = 50;
      
      for (let i = 0; i < words.length; i += maxWordsPerChunk - overlap) {
        const chunkWords = words.slice(i, i + maxWordsPerChunk);
        const chunkContent = chunkWords.join(' ');
        
        if (chunkContent.trim().length < 100) continue;
        
        const chunkIndex = Math.floor(i / (maxWordsPerChunk - overlap));
        
        chunks.push({
          id: `section_${sectionIndex}_para_${paragraphIndex}_chunk_${chunkIndex}`,
          content: chunkContent.trim(),
          metadata: {
            source: 'pierre-trading-system.md',
            section: sectionTitle,
            index: chunks.length,
          },
        });
      }
    });
  });

  return chunks;
}

// Run setup if this file is executed directly
setupPierreRAG().catch(console.error);