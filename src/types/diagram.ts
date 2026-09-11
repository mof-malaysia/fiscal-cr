export type DiagramMode = 'concept' | 'implementation';
export type DiagramChange = 'added' | 'modified' | 'removed' | 'context';

export interface DiagramEvidence {
  id: string;
  path: string;
  patch: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  change: DiagramChange;
  evidence: string[];
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string;
  change: DiagramChange;
  evidence: string[];
}

export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagramArtifact extends DiagramGraph {
  mode: DiagramMode;
  evidence: Array<{ id: string; path: string }>;
  headSha: string;
  scope: 'full' | 'delta';
  partial: boolean;
}
