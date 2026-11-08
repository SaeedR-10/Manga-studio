import { WorkspaceShell } from "@/components/workspace";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="app">
      <WorkspaceShell projectId={id} />
    </div>
  );
}
