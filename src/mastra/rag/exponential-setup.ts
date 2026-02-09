import { PgVector } from '@mastra/pg';
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { config } from 'dotenv';
config();

interface ChunkData {
  id: string;
  content: string;
  metadata: {
    source: string;
    section: string;
    type: 'docs' | 'schema';
    index: number;
  };
}

const EXPONENTIAL_PATH = join(process.cwd(), '..', 'exponential');
const DOCS_PATH = join(EXPONENTIAL_PATH, 'docs');
const SCHEMA_PATH = join(EXPONENTIAL_PATH, 'prisma', 'schema.prisma');
const CLAUDE_MD_PATH = join(EXPONENTIAL_PATH, 'CLAUDE.md');

export async function setupExponentialRAG() {
  const vectorStore = new PgVector({
    id: 'exponential-docs',
    connectionString: process.env.DATABASE_URL!,
    schemaName: 'exponential_docs',
  });

  await vectorStore.createIndex({
    indexName: 'exponential_knowledge',
    dimension: 1536,
    metric: 'cosine',
  });

  const chunks: ChunkData[] = [];

  // 1. Index all docs/*.md files
  const docFiles = readdirSync(DOCS_PATH).filter(f => f.endsWith('.md'));
  console.log(`📄 Found ${docFiles.length} doc files`);

  for (const file of docFiles) {
    const content = readFileSync(join(DOCS_PATH, file), 'utf-8');
    chunks.push(...chunkMarkdown(content, file));
  }

  // Also index testing subdirectory docs
  const testingDir = join(DOCS_PATH, 'testing');
  try {
    const testFiles = readdirSync(testingDir).filter(f => f.endsWith('.md'));
    for (const file of testFiles) {
      const content = readFileSync(join(testingDir, file), 'utf-8');
      chunks.push(...chunkMarkdown(content, `testing/${file}`));
    }
  } catch {
    // testing dir may not exist
  }

  // 2. Index CLAUDE.md (rich developer context)
  try {
    const claudeContent = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    chunks.push(...chunkMarkdown(claudeContent, 'CLAUDE.md'));
    console.log(`📄 Indexed CLAUDE.md`);
  } catch {
    console.warn('⚠️ CLAUDE.md not found, skipping');
  }

  // 3. Index Prisma schema by model
  try {
    const schemaContent = readFileSync(SCHEMA_PATH, 'utf-8');
    chunks.push(...chunkPrismaSchema(schemaContent));
    console.log(`📄 Indexed Prisma schema`);
  } catch {
    console.warn('⚠️ Prisma schema not found, skipping');
  }

  console.log(`\n📊 Total chunks: ${chunks.length}`);
  console.log(`Processing ${chunks.length} chunks...`);

  // Batch embed and upsert
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
      indexName: 'exponential_knowledge',
      vectors: embeddings,
      metadata: metadataArray,
      ids: ids,
    });

    console.log(`Processed ${processed}/${chunks.length} chunks`);
  }

  console.log(`\n✅ Successfully embedded ${chunks.length} chunks for Exponential knowledge base`);
}

function chunkMarkdown(content: string, filename: string): ChunkData[] {
  const chunks: ChunkData[] = [];
  const sections = content.split(/(?=^##\s)/m);

  sections.forEach((section, sectionIndex) => {
    if (section.trim().length === 0) return;

    const lines = section.split('\n');
    const sectionTitle = lines[0]?.replace(/^#+\s*/, '') || 'Unknown Section';

    const paragraphs = section.split(/\n\s*\n/).filter(p => p.trim().length > 0);

    paragraphs.forEach((paragraph, paragraphIndex) => {
      if (paragraph.trim().length < 100) return;

      const words = paragraph.split(/\s+/);
      const maxWordsPerChunk = 400;
      const overlap = 50;

      for (let i = 0; i < words.length; i += maxWordsPerChunk - overlap) {
        const chunkWords = words.slice(i, i + maxWordsPerChunk);
        const chunkContent = chunkWords.join(' ');

        if (chunkContent.trim().length < 100) continue;

        const chunkIndex = Math.floor(i / (maxWordsPerChunk - overlap));
        const safeFilename = filename.replace(/[^a-zA-Z0-9_-]/g, '_');

        chunks.push({
          id: `expo_${safeFilename}_s${sectionIndex}_p${paragraphIndex}_c${chunkIndex}`,
          content: chunkContent.trim(),
          metadata: {
            source: filename,
            section: sectionTitle,
            type: 'docs',
            index: chunks.length,
          },
        });
      }
    });
  });

  return chunks;
}

function chunkPrismaSchema(content: string): ChunkData[] {
  const chunks: ChunkData[] = [];

  // Split by model/enum/type blocks
  const blockRegex = /^(model|enum|type)\s+(\w+)\s*\{[^}]*\}/gm;
  let match;

  while ((match = blockRegex.exec(content)) !== null) {
    const blockType = match[1];
    const blockName = match[2];
    const blockContent = match[0];

    if (blockContent.trim().length < 50) continue;

    chunks.push({
      id: `expo_schema_${blockType}_${blockName}`,
      content: blockContent.trim(),
      metadata: {
        source: 'schema.prisma',
        section: `${blockType} ${blockName}`,
        type: 'schema',
        index: chunks.length,
      },
    });
  }

  return chunks;
}

// Run setup if this file is executed directly
setupExponentialRAG().catch(console.error);
